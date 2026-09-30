import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, like, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  analysisEvents,
  analysisJobs,
  caseFiles,
  cases,
  germlineCasePanels,
  germlineOrderDetails,
  germlinePanels,
  projects,
  samples,
  somaticCaseContexts,
  somaticPanels,
  somaticPanelVersions,
  somaticTumorTypes,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";
import {
  germlineOrderRow,
  germlineOrderSchema,
} from "@shared/germlineOrder";
import { runTriagePass } from "../domain/triagePass";
import {
  germlinePanelHash,
  parseGermlineBed,
  type GermlinePanelContent,
} from "../domain/germlinePanel";
import { parseVcf } from "../domain/vcf";
import { annotatedVcfFileName, ensureAnnotatedVcf, VcfAnnotationFailure } from "../domain/vepAnnotate";
import { variantReingestSet, variantReingestTarget } from "../domain/vcfIngest";
import { hpoGeneGroupsForText, loadHpoIndex, searchHpoTerms } from "../domain/hpoGenes";
import {
  emptyVcfSelectionLog,
  selectVcfRecords,
  variantInsertRow,
  vcfFilterSchema,
  type VcfFilterInput,
} from "../domain/vcfSelection";
import { storageCreateUploadUrl, storageGetSignedUrl, storagePut } from "../storage";

const caseStatus = z.enum([
  "draft",
  "queued",
  "running",
  "review_ready",
  "in_review",
  "reported",
  "failed",
]);

const sampleSchema = z.object({
  sampleCode: z.string().trim().min(1).max(80),
  role: z.enum(["proband", "mother", "father", "tumor", "normal", "other"]),
  specimenType: z.string().trim().min(1).max(100),
  tumorContentPercent: z.number().min(0).max(100).optional(),
});

const somaticContextSchema = z.object({
  tumorTypeId: z.number().int().positive().optional(),
  panelVersionId: z.number().int().positive().optional(),
  tumor: z.object({
    ontologySystem: z.string().trim().min(1).max(40).default("Internal"),
    ontologyVersion: z.string().trim().min(1).max(80).default("1"),
    code: z.string().trim().min(1).max(80),
    label: z.string().trim().min(2).max(255),
    primarySite: z.string().trim().min(1).max(160),
    histology: z.string().trim().max(160).optional(),
  }),
  panel: z.object({
    manufacturer: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(80),
    assayType: z.string().trim().min(1).max(120).default("Targeted DNA panel"),
  }),
  histologyText: z.string().trim().max(255).optional(),
  diseaseStatus: z.string().trim().max(80).optional(),
  specimenCollectionSite: z.string().trim().min(1).max(160),
  pairedNormal: z.boolean().default(false),
});

function safeFileName(fileName: string) {
  return fileName
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(-180);
}

async function requireCase(organizationId: number, caseId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!rows[0])
    throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
  return rows[0];
}

type CaseFileRow = typeof caseFiles.$inferSelect;

class VcfIngestFailure extends Error {
  readonly lines: string[];

  constructor(message: string, lines: string[]) {
    super(message);
    this.lines = lines;
  }
}

/** Jobs the user stopped while ingest was still reading the VCF. */
const stoppedJobIds = new Set<number>();

/**
 * Download, annotate when needed, then normalize a VCF into variants and mark the
 * job review_ready or failed. Runs after the submit response so VEP does not
 * block the request.
 */
async function ingestVcfForJob(params: {
  organizationId: number;
  caseId: number;
  jobId: number;
  vcfFile: CaseFileRow;
  referenceBuild: "GRCh37" | "GRCh38";
  purpose: "germline" | "somatic";
  vcfFilters?: VcfFilterInput | null;
}) {
  const {
    organizationId,
    caseId,
    jobId,
    vcfFile,
    referenceBuild,
    purpose,
    vcfFilters,
  } = params;
  const db = await requireDb();
  try {
    const signedUrl = await storageGetSignedUrl(vcfFile.storageKey);
    const response = await fetch(signedUrl);
    if (!response.ok)
      throw new Error(`VCF download failed (${response.status})`);
    const raw = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== vcfFile.sha256) throw new Error("VCF checksum mismatch");
    const decoded = vcfFile.fileName.endsWith(".gz")
      ? gunzipSync(raw).toString("utf8")
      : raw.toString("utf8");
    if (stoppedJobIds.has(jobId)) return;
    const started = await db
      .update(analysisJobs)
      .set({ status: "running", startedAt: new Date(), progressPercent: 10 })
      .where(
        and(
          eq(analysisJobs.id, jobId),
          eq(analysisJobs.organizationId, organizationId),
          inArray(analysisJobs.status, ["queued", "running"])
        )
      )
      .returning({ id: analysisJobs.id });
    if (!started.length || stoppedJobIds.has(jobId)) return;
    await db
      .update(cases)
      .set({ status: "running" })
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.organizationId, organizationId),
          inArray(cases.status, ["queued", "running"])
        )
      );
    const annotated = await ensureAnnotatedVcf({
      text: decoded,
      referenceBuild,
      shouldStop: () => stoppedJobIds.has(jobId),
      onEvent: async (message, progress) => {
        if (stoppedJobIds.has(jobId)) return;
        await db.insert(analysisEvents).values({
          organizationId,
          jobId,
          status: "running",
          message,
          progressPercent: progress,
        });
        await db
          .update(analysisJobs)
          .set({ progressPercent: progress })
          .where(
            and(
              eq(analysisJobs.id, jobId),
              eq(analysisJobs.organizationId, organizationId),
              inArray(analysisJobs.status, ["queued", "running"])
            )
          );
      },
    });
    if (stoppedJobIds.has(jobId)) return;
    const text = annotated.text;
    if (annotated.gzip) {
      const fileName = annotatedVcfFileName(vcfFile.fileName);
      const sha256 = createHash("sha256").update(annotated.gzip).digest("hex");
      const stored = await storagePut(
        `organizations/${organizationId}/cases/${caseId}/files/${fileName}`,
        annotated.gzip,
        "application/gzip"
      );
      const [job] = await db
        .select({ createdBy: analysisJobs.createdBy })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.id, jobId),
            eq(analysisJobs.organizationId, organizationId)
          )
        )
        .limit(1);
      if (!job) throw new Error("Analysis job disappeared before the annotated VCF was saved");
      await db
        .delete(caseFiles)
        .where(
          and(
            eq(caseFiles.organizationId, organizationId),
            eq(caseFiles.caseId, caseId),
            eq(caseFiles.kind, "annotated_vcf")
          )
        );
      await db.insert(caseFiles).values({
        organizationId,
        caseId,
        kind: "annotated_vcf",
        fileName,
        storageKey: stored.key,
        storageUrl: stored.url,
        mimeType: "application/gzip",
        byteSize: annotated.gzip.length,
        sha256,
        status: "verified",
        uploadedBy: job.createdBy,
      });
      await db.insert(analysisEvents).values({
        organizationId,
        jobId,
        status: "running",
        message: `Annotated VCF saved: ${fileName}`,
        progressPercent: 70,
      });
    }
    const panelRows = await db
      .select()
      .from(germlineCasePanels)
      .where(
        and(
          eq(germlineCasePanels.organizationId, organizationId),
          eq(germlineCasePanels.caseId, caseId)
        )
      )
      .limit(1);
    const panelScope: GermlinePanelContent | null = panelRows[0]
      ? { genes: panelRows[0].genes, regions: panelRows[0].regions }
      : null;
    const scoped = Boolean(vcfFilters || panelScope);
    const selection = scoped
      ? await selectVcfRecords(
          text,
          referenceBuild,
          vcfFilters ?? {
            hpo: "",
            genes: "",
            maxAf: null,
            minQual: null,
            minGenotypeQuality: null,
            minDepth: null,
            passOnly: false,
            codingOnly: false,
          },
          panelScope
        )
      : null;
    const parsed = selection
      ? selection.filtered.kept
      : parseVcf(text, referenceBuild);
    if (selection?.steps.length && !stoppedJobIds.has(jobId)) {
      await db.insert(analysisEvents).values({
        organizationId,
        jobId,
        status: "running",
        message:
          "Filters applied in this order. A variant is removed at the first step it fails.",
        progressPercent: 80,
        metadata: { steps: selection.steps },
      });
    }
    if (!parsed.length) {
      if (!selection) throw new Error("VCF contains no readable variant records");
      const lines = emptyVcfSelectionLog({
        parsedCount: selection.parsedCount,
        truncated: selection.truncated,
        dropped: selection.filtered.dropped,
        filters: vcfFilters ?? {
          hpo: "",
          genes: "",
          maxAf: null,
          minQual: null,
          minGenotypeQuality: null,
          minDepth: null,
          passOnly: false,
          codingOnly: false,
        },
        geneCount: selection.geneCount,
        recordsWithoutGene: selection.recordsWithoutGene,
        afFromInfoOnly: selection.afFromInfoOnly,
      });
      throw new VcfIngestFailure(
        "No variants passed the panel, HPO, gene list, frequency, and quality filters.",
        lines
      );
    }
    const keptNote = selection
      ? ` Kept ${parsed.length.toLocaleString()} of ${selection.parsedCount.toLocaleString()} after the filters that could be applied.${selection.notes.length ? ` ${selection.notes.join(" ")}` : ""}`
      : "";
    if (stoppedJobIds.has(jobId)) return;
    await db.transaction(async tx => {
      for (let offset = 0; offset < parsed.length; offset += 500) {
        await tx
          .insert(variants)
          .values(
            parsed.slice(offset, offset + 500).map(variant => ({
              ...variantInsertRow(variant),
              organizationId,
              caseId,
            }))
          )
          .onConflictDoUpdate({
            target: [...variantReingestTarget],
            set: variantReingestSet,
          });
      }
      const finished = await tx
        .update(analysisJobs)
        .set({
          status: "review_ready",
          progressPercent: 100,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(analysisJobs.id, jobId),
            eq(analysisJobs.organizationId, organizationId),
            inArray(analysisJobs.status, ["queued", "running"])
          )
        )
        .returning({ id: analysisJobs.id });
      if (!finished.length) return;
      await tx.insert(analysisEvents).values({
        organizationId,
        jobId,
        status: "review_ready",
        message: `Normalized ${parsed.length.toLocaleString()} variant(s) — ready for review.${keptNote}`,
        progressPercent: 100,
      });
      await tx
        .update(cases)
        .set({ status: "review_ready" })
        .where(
          and(
            eq(cases.id, caseId),
            eq(cases.organizationId, organizationId),
            inArray(cases.status, ["queued", "running"])
          )
        );
    });
    if (purpose === "germline") {
      try {
        await runTriagePass(organizationId, caseId);
      } catch (error) {
        console.warn(
          `[VCF] germline triage after ingest failed for case ${caseId}:`,
          error
        );
      }
    }
  } catch (error) {
    if (stoppedJobIds.has(jobId)) return;
    const message =
      error instanceof Error ? error.message : "VCF ingestion failed";
    await db
      .update(analysisJobs)
      .set({ status: "failed", errorMessage: message, completedAt: new Date() })
      .where(
        and(
          eq(analysisJobs.id, jobId),
          eq(analysisJobs.organizationId, organizationId)
        )
      );
    await db.insert(analysisEvents).values({
      organizationId,
      jobId,
      status: "failed",
      message,
      progressPercent: 0,
      metadata:
        error instanceof VcfIngestFailure || error instanceof VcfAnnotationFailure
          ? { lines: error.lines }
          : null,
    });
    await db
      .update(cases)
      .set({ status: "failed" })
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.organizationId, organizationId),
          inArray(cases.status, ["queued", "running"])
        )
      );
  } finally {
    stoppedJobIds.delete(jobId);
  }
}

export const casesRouter = router({
  somaticCatalog: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const db = await requireDb();
      const [tumors, panelVersions] = await Promise.all([
        db
          .select()
          .from(somaticTumorTypes)
          .where(eq(somaticTumorTypes.active, true))
          .orderBy(
            asc(somaticTumorTypes.label),
            desc(somaticTumorTypes.ontologyVersion)
          ),
        db
          .select({
            panel: somaticPanels,
            version: somaticPanelVersions,
          })
          .from(somaticPanelVersions)
          .innerJoin(
            somaticPanels,
            and(
              eq(somaticPanels.id, somaticPanelVersions.panelId),
              eq(
                somaticPanels.organizationId,
                somaticPanelVersions.organizationId
              )
            )
          )
          .where(eq(somaticPanelVersions.organizationId, input.organizationId))
          .orderBy(
            asc(somaticPanels.manufacturer),
            asc(somaticPanels.name),
            desc(somaticPanelVersions.version)
          ),
      ]);
      return { tumors, panelVersions };
    }),

  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive().optional(),
        status: caseStatus.optional(),
        purpose: z.enum(["germline", "somatic"]).optional(),
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const db = await requireDb();
      const conditions = [eq(cases.organizationId, input.organizationId)];
      if (input.projectId)
        conditions.push(eq(cases.projectId, input.projectId));
      if (input.status) conditions.push(eq(cases.status, input.status));
      if (input.purpose) conditions.push(eq(cases.purpose, input.purpose));
      if (input.search) {
        conditions.push(
          or(
            like(cases.caseNumber, `%${input.search}%`),
            like(cases.patientAlias, `%${input.search}%`)
          )!
        );
      }
      return db
        .select({
          id: cases.id,
          projectId: cases.projectId,
          projectName: projects.name,
          caseNumber: cases.caseNumber,
          patientAlias: cases.patientAlias,
          purpose: cases.purpose,
          inputType: cases.inputType,
          referenceBuild: cases.referenceBuild,
          panelName: cases.panelName,
          status: cases.status,
          updatedAt: cases.updatedAt,
        })
        .from(cases)
        .innerJoin(
          projects,
          and(
            eq(projects.id, cases.projectId),
            eq(projects.organizationId, cases.organizationId)
          )
        )
        .where(and(...conditions))
        .orderBy(desc(cases.updatedAt))
        .limit(input.limit);
    }),

  get: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      const db = await requireDb();
      const [
        sampleRows,
        fileRows,
        jobRows,
        variantCount,
        somaticContextRows,
        germlinePanelRows,
          germlineOrderRows,
          projectRows,
        ] = await Promise.all([
          db
            .select()
            .from(samples)
            .where(
              and(
                eq(samples.organizationId, input.organizationId),
                eq(samples.caseId, input.caseId)
              )
            ),
          db
            .select()
            .from(caseFiles)
            .where(
              and(
                eq(caseFiles.organizationId, input.organizationId),
                eq(caseFiles.caseId, input.caseId)
              )
            ),
          db
            .select()
            .from(analysisJobs)
            .where(
              and(
                eq(analysisJobs.organizationId, input.organizationId),
                eq(analysisJobs.caseId, input.caseId)
              )
            )
            .orderBy(desc(analysisJobs.createdAt)),
          db
            .select({ count: count() })
            .from(variants)
            .where(
              and(
                eq(variants.organizationId, input.organizationId),
                eq(variants.caseId, input.caseId)
              )
            ),
          db
            .select({
              id: somaticCaseContexts.id,
              histologyText: somaticCaseContexts.histologyText,
              diseaseStatus: somaticCaseContexts.diseaseStatus,
              specimenCollectionSite:
                somaticCaseContexts.specimenCollectionSite,
              pairedNormal: somaticCaseContexts.pairedNormal,
              tumorTypeId: somaticTumorTypes.id,
              tumorCode: somaticTumorTypes.code,
              tumorLabel: somaticTumorTypes.label,
              ontologySystem: somaticTumorTypes.ontologySystem,
              ontologyVersion: somaticTumorTypes.ontologyVersion,
              primarySite: somaticTumorTypes.primarySite,
              panelVersionId: somaticPanelVersions.id,
              panelVersion: somaticPanelVersions.version,
              panelName: somaticPanels.name,
              panelManufacturer: somaticPanels.manufacturer,
              assayType: somaticPanelVersions.assayType,
            })
            .from(somaticCaseContexts)
            .innerJoin(
              somaticTumorTypes,
              eq(somaticTumorTypes.id, somaticCaseContexts.primaryTumorTypeId)
            )
            .innerJoin(
              somaticPanelVersions,
              and(
                eq(somaticPanelVersions.id, somaticCaseContexts.panelVersionId),
                eq(
                  somaticPanelVersions.organizationId,
                  somaticCaseContexts.organizationId
                )
              )
            )
            .innerJoin(
              somaticPanels,
              and(
                eq(somaticPanels.id, somaticPanelVersions.panelId),
                eq(
                  somaticPanels.organizationId,
                  somaticPanelVersions.organizationId
                )
              )
            )
            .where(
              and(
                eq(somaticCaseContexts.organizationId, input.organizationId),
                eq(somaticCaseContexts.caseId, input.caseId)
              )
            )
            .limit(1),
          db
            .select({
              name: germlineCasePanels.name,
              genomeBuild: germlineCasePanels.genomeBuild,
              contentHash: germlineCasePanels.contentHash,
              genes: germlineCasePanels.genes,
              regions: germlineCasePanels.regions,
            })
            .from(germlineCasePanels)
            .where(
              and(
                eq(germlineCasePanels.organizationId, input.organizationId),
                eq(germlineCasePanels.caseId, input.caseId)
              )
            )
            .limit(1),
          db
            .select()
            .from(germlineOrderDetails)
            .where(
              and(
                eq(germlineOrderDetails.organizationId, input.organizationId),
                eq(germlineOrderDetails.caseId, input.caseId)
              )
            )
            .limit(1),
          db
            .select({ name: projects.name, code: projects.code })
            .from(projects)
            .where(
              and(
                eq(projects.id, clinicalCase.projectId),
                eq(projects.organizationId, input.organizationId)
              )
            )
            .limit(1),
        ]);
      const attachedPanel = germlinePanelRows[0];
      const latestManifest = jobRows[0]?.manifest;
      const appliedHpo =
        latestManifest &&
        typeof latestManifest === "object" &&
        typeof (latestManifest as { vcfFilters?: { hpo?: unknown } }).vcfFilters?.hpo === "string"
          ? (latestManifest as { vcfFilters: { hpo: string } }).vcfFilters.hpo
          : "";
      return {
        ...clinicalCase,
        samples: sampleRows,
        files: fileRows,
        jobs: jobRows,
        variantCount: variantCount[0]?.count || 0,
        somaticContext: somaticContextRows[0] ?? null,
        germlinePanel: attachedPanel
          ? {
              name: attachedPanel.name,
              genomeBuild: attachedPanel.genomeBuild,
              contentHash: attachedPanel.contentHash,
              geneCount: attachedPanel.genes.length,
              regionCount: attachedPanel.regions?.length ?? 0,
            }
          : null,
        projectName: projectRows[0]?.name ?? "",
        projectCode: projectRows[0]?.code ?? "",
        hpoGenes: await hpoGeneGroupsForText(appliedHpo),
        germlineOrder: germlineOrderRows[0]
          ? {
              testCategory: germlineOrderRows[0].testCategory,
              otherTestType: germlineOrderRows[0].otherTestType ?? "",
              packageCode: germlineOrderRows[0].packageCode ?? "",
              reportMode: germlineOrderRows[0].reportMode,
              partnerCaseNumber: germlineOrderRows[0].partnerCaseNumber ?? "",
              priorCaseNumber: germlineOrderRows[0].priorCaseNumber ?? "",
              patientName: germlineOrderRows[0].patientName ?? "",
              patientBirth: germlineOrderRows[0].patientBirth ?? "",
              patientGender: germlineOrderRows[0].patientGender ?? "",
              patient2Name: germlineOrderRows[0].patient2Name ?? "",
              patient2Birth: germlineOrderRows[0].patient2Birth ?? "",
              patient2Gender: germlineOrderRows[0].patient2Gender ?? "",
              patient2Affected: germlineOrderRows[0].patient2Affected ?? "",
              patient3Name: germlineOrderRows[0].patient3Name ?? "",
              patient3Birth: germlineOrderRows[0].patient3Birth ?? "",
              patient3Gender: germlineOrderRows[0].patient3Gender ?? "",
              patient3Affected: germlineOrderRows[0].patient3Affected ?? "",
              hospitalName: germlineOrderRows[0].hospitalName ?? "",
              doctor: germlineOrderRows[0].doctor ?? "",
              medicalRecordId: germlineOrderRows[0].medicalRecordId ?? "",
              sampleId: germlineOrderRows[0].sampleId ?? "",
              affected: germlineOrderRows[0].affected ?? "",
              clinicalInformation: germlineOrderRows[0].clinicalInformation ?? "",
              sampleCollectionDate: germlineOrderRows[0].sampleCollectionDate ?? "",
              receiptDate: germlineOrderRows[0].receiptDate ?? "",
              reportLanguage: germlineOrderRows[0].reportLanguage ?? "",
              reportType: germlineOrderRows[0].reportType ?? "",
              specimenType: germlineOrderRows[0].specimenType ?? "Blood",
              sampleBarcode: germlineOrderRows[0].sampleBarcode ?? "",
            }
          : null,
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive(),
        caseNumber: z.string().trim().min(2).max(64),
        patientAlias: z.string().trim().min(1).max(120),
        purpose: z.enum(["germline", "somatic"]),
        inputType: z.literal("vcf"),
        referenceBuild: z.enum(["GRCh37", "GRCh38"]),
        panelName: z.string().trim().max(160).optional(),
        indication: z.string().trim().max(4000).optional(),
        phenotypeText: z.string().trim().max(4000).optional(),
        somaticContext: somaticContextSchema.optional(),
        consentClinicalAnalysis: z.literal(true),
        consentSecondaryFindings: z.boolean().default(false),
        consentDataUse: z.boolean().default(false),
        samples: z.array(sampleSchema).min(1).max(5),
        germlinePanel: z
          .object({
            panelId: z.number().int().positive().optional(),
            bedText: z.string().max(20_000_000).optional(),
            name: z.string().trim().min(2).max(200).optional(),
          })
          .optional(),
        germlineOrder: germlineOrderSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:create"
      );
      if (input.purpose === "somatic" && !input.somaticContext) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Somatic cases require a coded primary tumor and target panel version.",
        });
      }
      if (input.purpose === "germline" && input.somaticContext) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Somatic tumor and panel context cannot be attached to a germline case.",
        });
      }
      if (input.purpose === "somatic" && input.germlinePanel) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A germline interpretation panel cannot be attached to a somatic case.",
        });
      }
      if (input.purpose === "somatic" && input.germlineOrder) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Germline order details cannot be attached to a somatic case.",
        });
      }
      const db = await requireDb();
      let germlineScope: {
        panelId: number | null;
        name: string;
        content: GermlinePanelContent;
        genomeBuild: "GRCh37" | "GRCh38" | null;
      } | null = null;
      if (input.germlinePanel) {
        const hasCatalog = input.germlinePanel.panelId != null;
        const hasBed = Boolean(input.germlinePanel.bedText?.trim());
        if (hasCatalog === hasBed) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a saved panel or upload one BED file.",
          });
        }
        if (hasCatalog) {
          const rows = await db
            .select()
            .from(germlinePanels)
            .where(
              and(
                eq(germlinePanels.id, input.germlinePanel.panelId!),
                eq(germlinePanels.organizationId, input.organizationId)
              )
            )
            .limit(1);
          const panel = rows[0];
          if (!panel) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Germline panel not found.",
            });
          }
          if (panel.genomeBuild && panel.genomeBuild !== input.referenceBuild) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "The saved panel reference build does not match this case.",
            });
          }
          germlineScope = {
            panelId: panel.id,
            name: panel.name,
            content: { genes: panel.genes, regions: panel.regions },
            genomeBuild: panel.genomeBuild,
          };
        } else {
          if (!input.germlinePanel.name) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A BED uploaded with the case needs a panel name.",
            });
          }
          let content: GermlinePanelContent;
          try {
            content = parseGermlineBed(input.germlinePanel.bedText || "");
          } catch (error) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                error instanceof Error ? error.message : "Invalid BED panel.",
            });
          }
          germlineScope = {
            panelId: null,
            name: input.germlinePanel.name,
            content,
            genomeBuild: input.referenceBuild,
          };
        }
      }
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId),
            eq(projects.status, "active")
          )
        )
        .limit(1);
      if (!project[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      const { caseId, sampleIds } = await db.transaction(async tx => {
        let tumorTypeId: number | null = null;
        let panelVersionId: number | null = null;
        if (input.somaticContext) {
          if (input.somaticContext.tumorTypeId) {
            const selected = await tx
              .select({ id: somaticTumorTypes.id })
              .from(somaticTumorTypes)
              .where(
                and(
                  eq(somaticTumorTypes.id, input.somaticContext.tumorTypeId),
                  eq(somaticTumorTypes.active, true)
                )
              )
              .limit(1);
            if (!selected[0]) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "The selected tumor concept is unavailable.",
              });
            }
            tumorTypeId = selected[0].id;
          } else {
            const tumorRows = await tx
              .insert(somaticTumorTypes)
              .values({
                ontologySystem: input.somaticContext.tumor.ontologySystem,
                ontologyVersion: input.somaticContext.tumor.ontologyVersion,
                code: input.somaticContext.tumor.code,
                label: input.somaticContext.tumor.label,
                primarySite: input.somaticContext.tumor.primarySite,
                histology: input.somaticContext.tumor.histology || null,
              })
              .onConflictDoNothing()
              .returning({ id: somaticTumorTypes.id });
            if (tumorRows[0]) {
              tumorTypeId = tumorRows[0].id;
            } else {
              const existing = await tx
                .select({ id: somaticTumorTypes.id })
                .from(somaticTumorTypes)
                .where(
                  and(
                    eq(
                      somaticTumorTypes.ontologySystem,
                      input.somaticContext.tumor.ontologySystem
                    ),
                    eq(
                      somaticTumorTypes.ontologyVersion,
                      input.somaticContext.tumor.ontologyVersion
                    ),
                    eq(somaticTumorTypes.code, input.somaticContext.tumor.code)
                  )
                )
                .limit(1);
              tumorTypeId = existing[0]?.id ?? null;
            }
          }
          if (input.somaticContext.panelVersionId) {
            const selected = await tx
              .select({ id: somaticPanelVersions.id })
              .from(somaticPanelVersions)
              .where(
                and(
                  eq(
                    somaticPanelVersions.id,
                    input.somaticContext.panelVersionId
                  ),
                  eq(somaticPanelVersions.organizationId, input.organizationId),
                  eq(somaticPanelVersions.genomeBuild, input.referenceBuild)
                )
              )
              .limit(1);
            if (!selected[0]) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  "The selected panel version is unavailable or uses a different genome build.",
              });
            }
            panelVersionId = selected[0].id;
          } else {
            const panelRows = await tx
              .insert(somaticPanels)
              .values({
                organizationId: input.organizationId,
                manufacturer: input.somaticContext.panel.manufacturer,
                name: input.somaticContext.panel.name,
                createdBy: ctx.user.id,
              })
              .onConflictDoUpdate({
                target: [
                  somaticPanels.organizationId,
                  somaticPanels.manufacturer,
                  somaticPanels.name,
                ],
                set: { updatedAt: new Date() },
              })
              .returning({ id: somaticPanels.id });
            const panelVersionRows = await tx
              .insert(somaticPanelVersions)
              .values({
                organizationId: input.organizationId,
                panelId: panelRows[0].id,
                version: input.somaticContext.panel.version,
                genomeBuild: input.referenceBuild,
                assayType: input.somaticContext.panel.assayType,
                capabilities: {
                  snvIndel: true,
                  cnv: false,
                  fusion: false,
                  msi: false,
                  tmb: false,
                  hrd: false,
                },
              })
              .onConflictDoNothing()
              .returning({ id: somaticPanelVersions.id });
            if (panelVersionRows[0]) {
              panelVersionId = panelVersionRows[0].id;
            } else {
              const existing = await tx
                .select({ id: somaticPanelVersions.id })
                .from(somaticPanelVersions)
                .where(
                  and(
                    eq(
                      somaticPanelVersions.organizationId,
                      input.organizationId
                    ),
                    eq(somaticPanelVersions.panelId, panelRows[0].id),
                    eq(
                      somaticPanelVersions.version,
                      input.somaticContext.panel.version
                    )
                  )
                )
                .limit(1);
              panelVersionId = existing[0]?.id ?? null;
            }
          }
          if (!tumorTypeId || !panelVersionId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Somatic tumor or panel catalog resolution failed.",
            });
          }
        }
        const result = await tx
          .insert(cases)
          .values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            caseNumber: input.caseNumber,
            patientAlias: input.patientAlias,
            purpose: input.purpose,
            inputType: input.inputType,
            referenceBuild: input.referenceBuild,
            panelName:
              input.purpose === "somatic" && input.somaticContext?.panel
                ? `${input.somaticContext.panel.manufacturer} ${input.somaticContext.panel.name} ${input.somaticContext.panel.version}`
                : germlineScope?.name || input.panelName || null,
            indication: input.indication || null,
            phenotypeText: input.phenotypeText || null,
            consentClinicalAnalysis: input.consentClinicalAnalysis,
            consentSecondaryFindings: input.consentSecondaryFindings,
            consentDataUse: input.consentDataUse,
            createdBy: ctx.user.id,
          })
          .returning({ id: cases.id });
        const id = result[0].id;
        if (germlineScope) {
          await tx.insert(germlineCasePanels).values({
            organizationId: input.organizationId,
            caseId: id,
            panelId: germlineScope.panelId,
            name: germlineScope.name,
            genes: germlineScope.content.genes,
            regions: germlineScope.content.regions,
            genomeBuild: germlineScope.genomeBuild,
            contentHash: germlinePanelHash(
              germlineScope.content,
              germlineScope.genomeBuild
            ),
          });
        }
        if (input.purpose === "germline" && input.germlineOrder) {
          const order = germlineOrderRow({
            ...input.germlineOrder,
            patientName: input.germlineOrder.patientName || input.patientAlias,
            clinicalInformation:
              input.germlineOrder.clinicalInformation || input.indication || "",
          });
          await tx.insert(germlineOrderDetails).values({
            organizationId: input.organizationId,
            caseId: id,
            ...order,
            updatedBy: ctx.user.id,
          });
        }
        if (input.somaticContext && tumorTypeId && panelVersionId) {
          await tx.insert(somaticCaseContexts).values({
            organizationId: input.organizationId,
            caseId: id,
            primaryTumorTypeId: tumorTypeId,
            panelVersionId,
            histologyText: input.somaticContext.histologyText || null,
            diseaseStatus: input.somaticContext.diseaseStatus || null,
            specimenCollectionSite: input.somaticContext.specimenCollectionSite,
            pairedNormal: input.somaticContext.pairedNormal,
            mappingProvenance: {
              method: input.somaticContext.tumorTypeId
                ? "catalog_selected"
                : "manual_concept_created",
              tumorTypeId,
              panelVersionId,
              selectedAt: new Date().toISOString(),
            },
          });
        }
        const sampleResult = await tx
          .insert(samples)
          .values(
            input.samples.map(sample => ({
              organizationId: input.organizationId,
              caseId: id,
              sampleCode: sample.sampleCode,
              role: sample.role,
              specimenType:
                input.germlineOrder?.specimenType || sample.specimenType,
              tumorContentPercent:
                sample.tumorContentPercent === undefined
                  ? null
                  : String(sample.tumorContentPercent),
            }))
          )
          .returning({ id: samples.id });
        return { caseId: id, sampleIds: sampleResult.map(row => row.id) };
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.created",
        entityType: "case",
        entityId: caseId,
        after: {
          caseNumber: input.caseNumber,
          purpose: input.purpose,
          inputType: input.inputType,
        },
        req: ctx.req,
      });
      return { id: caseId, sampleIds };
    }),

  updateGermlineOrder: protectedProcedure
    .input(
      z
        .object({
          organizationId: z.number().int().positive(),
          caseId: z.number().int().positive(),
        })
        .merge(germlineOrderSchema)
        .merge(
          z.object({
            phenotypeText: z.string().trim().max(4000).optional(),
            indication: z.string().trim().max(4000).optional(),
            panelName: z.string().trim().max(160).optional(),
          })
        )
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:edit"
      );
      const db = await requireDb();
      const found = await db
        .select({ id: cases.id, purpose: cases.purpose })
        .from(cases)
        .where(
          and(
            eq(cases.id, input.caseId),
            eq(cases.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!found[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Case not found." });
      }
      if (found[0].purpose !== "germline") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Order details are stored for germline cases.",
        });
      }
      const order = germlineOrderRow(input);
      await db
        .insert(germlineOrderDetails)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          ...order,
          updatedBy: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: [
            germlineOrderDetails.organizationId,
            germlineOrderDetails.caseId,
          ],
          set: { ...order, updatedBy: ctx.user.id, updatedAt: new Date() },
        });
      await db
        .update(cases)
        .set({
          phenotypeText: input.phenotypeText?.trim() || null,
          indication: input.indication?.trim() || null,
          panelName: input.panelName?.trim() || null,
        })
        .where(
          and(
            eq(cases.id, input.caseId),
            eq(cases.organizationId, input.organizationId)
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "germline.order.updated",
        entityType: "case",
        entityId: input.caseId,
        after: {
          testCategory: order.testCategory,
          packageCode: order.packageCode,
          hospitalName: order.hospitalName,
        },
        req: ctx.req,
      });
      return { ok: true };
    }),

  requestUpload: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        sampleId: z.number().int().positive().optional(),
        kind: z.enum([
          "vcf",
          "fastq_r1",
          "fastq_r2",
          "bam",
          "bai",
          "report",
          "panel_bed",
          "coverage",
          "assay_result",
          "other",
        ]),
        fileName: z.string().trim().min(1).max(255),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "file:upload"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Files can only be added to a draft case",
        });
      }
      if (input.kind === "fastq_r1" || input.kind === "fastq_r2" || input.kind === "bam" || input.kind === "bai") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Only VCF input is accepted. FASTQ, BAM, and IGV alignment files are not used.",
        });
      }
      if (input.sampleId) {
        const db = await requireDb();
        const sample = await db
          .select({ id: samples.id })
          .from(samples)
          .where(
            and(
              eq(samples.id, input.sampleId),
              eq(samples.organizationId, input.organizationId),
              eq(samples.caseId, input.caseId)
            )
          )
          .limit(1);
        if (!sample[0])
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Sample not found",
          });
      }
      const key = `organizations/${input.organizationId}/cases/${input.caseId}/files/${randomUUID()}-${safeFileName(input.fileName)}`;
      return storageCreateUploadUrl(key);
    }),

  completeUpload: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        sampleId: z.number().int().positive().optional(),
        kind: z.enum(["vcf", "fastq_r1", "fastq_r2", "bam", "bai", "other"]),
        fileName: z.string().trim().min(1).max(255),
        storageKey: z.string().min(20).max(512),
        accessUrl: z.string().min(10).max(768),
        mimeType: z.string().min(1).max(160),
        // Client-attested size/digest; VCF ingest re-verifies sha256 on download.
        byteSize: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "file:upload"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Files can only be added to a draft case",
        });
      }
      if (input.kind !== "vcf") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Only VCF input is accepted. FASTQ, BAM, and IGV alignment files are not used.",
        });
      }
      const requiredPrefix = `organizations/${input.organizationId}/cases/${input.caseId}/files/`;
      const publicBase = (process.env.AWS_PUBLIC_URL ?? "").replace(/\/+$/, "");
      const expectedAccessUrl = publicBase
        ? `${publicBase}/${input.storageKey}`
        : `/storage/${input.storageKey}`;
      if (
        !input.storageKey.startsWith(requiredPrefix) ||
        input.accessUrl !== expectedAccessUrl
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Storage path is outside the case boundary",
        });
      }
      const db = await requireDb();
      const result = await db
        .insert(caseFiles)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          sampleId: input.sampleId || null,
          kind: input.kind,
          fileName: input.fileName,
          storageKey: input.storageKey,
          storageUrl: input.accessUrl,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          sha256: input.sha256.toLowerCase(),
          uploadedBy: ctx.user.id,
        })
        .returning({ id: caseFiles.id });
      const id = result[0].id;
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "file.uploaded",
        entityType: "case_file",
        entityId: id,
        after: {
          caseId: input.caseId,
          kind: input.kind,
          fileName: input.fileName,
          sha256: input.sha256,
        },
        req: ctx.req,
      });
      return { id };
    }),

  searchHpo: protectedProcedure
    .input(z.object({ q: z.string().max(80) }))
    .query(async ({ input }) => {
      const index = await loadHpoIndex();
      if (!index) return [];
      return searchHpoTerms(index, input.q);
    }),

  previewVcf: protectedProcedure
    .input(
      z
        .object({
          organizationId: z.number().int().positive(),
          vcfText: z.string().min(1).max(20_000_000),
          referenceBuild: z.enum(["GRCh37", "GRCh38"]),
        })
        .merge(vcfFilterSchema)
        .extend({
          germlinePanel: z
            .object({
              panelId: z.number().int().positive().optional(),
              bedText: z.string().max(20_000_000).optional(),
            })
            .optional(),
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:create"
      );
      const db = await requireDb();
      let panelScope: GermlinePanelContent | null = null;
      if (input.germlinePanel?.panelId && input.germlinePanel.bedText?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a saved panel or upload one BED file.",
        });
      }
      if (input.germlinePanel?.panelId) {
        const rows = await db
          .select()
          .from(germlinePanels)
          .where(
            and(
              eq(germlinePanels.id, input.germlinePanel.panelId),
              eq(germlinePanels.organizationId, input.organizationId)
            )
          )
          .limit(1);
        const panel = rows[0];
        if (!panel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Germline panel not found.",
          });
        }
        if (panel.genomeBuild && panel.genomeBuild !== input.referenceBuild) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The saved panel reference build does not match this case.",
          });
        }
        panelScope = { genes: panel.genes, regions: panel.regions };
      } else if (input.germlinePanel?.bedText?.trim()) {
        try {
          panelScope = parseGermlineBed(input.germlinePanel.bedText);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Invalid BED panel.",
          });
        }
      }
      const result = await selectVcfRecords(
        input.vcfText,
        input.referenceBuild,
        input,
        panelScope
      );
      return {
        parsedCount: result.parsedCount,
        truncated: result.truncated,
        geneCount: result.geneCount,
        panelCount: result.panelCount,
        matches: result.matches.slice(0, 12),
        unmatched: result.unmatched,
        dropped: result.filtered.dropped,
        kept: result.filtered.kept.length,
        sample: result.filtered.kept.slice(0, 8).map(row => ({
          gene: row.gene,
          hgvsC: row.hgvsC,
        })),
      };
    }),

  submit: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        vcfFilters: vcfFilterSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:edit"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status !== "draft")
        throw new TRPCError({
          code: "CONFLICT",
          message: "Case is already submitted",
        });
      const db = await requireDb();
      if (clinicalCase.purpose === "somatic") {
        if (clinicalCase.inputType !== "vcf") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Somatic Phase 1 interpretation accepts target-panel VCF input only.",
          });
        }
        const context = await db
          .select({ id: somaticCaseContexts.id })
          .from(somaticCaseContexts)
          .where(
            and(
              eq(somaticCaseContexts.organizationId, input.organizationId),
              eq(somaticCaseContexts.caseId, input.caseId)
            )
          )
          .limit(1);
        if (!context[0]) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Somatic interpretation requires primary tumor and target panel context.",
          });
        }
      }
      const files = await db
        .select()
        .from(caseFiles)
        .where(
          and(
            eq(caseFiles.organizationId, input.organizationId),
            eq(caseFiles.caseId, input.caseId)
          )
        );
      const kinds = new Set(files.map(file => file.kind));
      if (clinicalCase.inputType !== "vcf") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Only VCF cases can be interpreted. External sequencing pipelines are disabled.",
        });
      }
      if (!kinds.has("vcf")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A VCF file is required",
        });
      }
      const idempotencyKey = randomUUID();
      const pipeline = "vcf_ingest" as const;
      const manifest = {
        schemaVersion: "1.0",
        serviceCode: "gvi_vcf_ingest",
        organizationId: input.organizationId,
        caseId: input.caseId,
        purpose: clinicalCase.purpose,
        referenceBuild: clinicalCase.referenceBuild,
        panelName: clinicalCase.panelName,
        files: files.map(file => ({
          id: file.id,
          kind: file.kind,
          storageKey: file.storageKey,
          sha256: file.sha256,
        })),
        vcfFilters:
          clinicalCase.inputType === "vcf" ? (input.vcfFilters ?? null) : null,
      };
      const jobId = await db.transaction(async tx => {
        const result = await tx
          .insert(analysisJobs)
          .values({
            organizationId: input.organizationId,
            caseId: input.caseId,
            pipeline,
            status: "queued",
            progressPercent: 0,
            idempotencyKey,
            manifest,
            createdBy: ctx.user.id,
          })
          .returning({ id: analysisJobs.id });
        const id = result[0].id;
        await tx.insert(analysisEvents).values({
          organizationId: input.organizationId,
          jobId: id,
          status: "queued",
          message: "Analysis request securely queued.",
          progressPercent: 0,
        });
        const cas = await tx
          .update(cases)
          .set({ status: "queued" })
          .where(
            and(
              eq(cases.id, input.caseId),
              eq(cases.organizationId, input.organizationId),
              eq(cases.status, "draft")
            )
          )
          .returning({ id: cases.id });
        if (cas.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Case is already submitted",
          });
        }
        return id;
      });

      const vcfFile = files.find(file => file.kind === "vcf");
      if (clinicalCase.inputType === "vcf" && vcfFile) {
        const ingestArgs = {
          organizationId: input.organizationId,
          caseId: input.caseId,
          jobId,
          vcfFile,
          referenceBuild: clinicalCase.referenceBuild,
          purpose: clinicalCase.purpose,
          vcfFilters: input.vcfFilters ?? null,
        };
        void ingestVcfForJob(ingestArgs).catch(error => {
          console.error("[vcf_ingest] background ingest failed", {
            caseId: input.caseId,
            jobId,
            error,
          });
        });
      }

      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.submitted",
        entityType: "analysis_job",
        entityId: jobId,
        after: {
          caseId: input.caseId,
          pipeline: manifest.serviceCode,
          idempotencyKey,
        },
        req: ctx.req,
      });
      return { jobId };
    }),

  downloadFile: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        fileId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const db = await requireDb();
      const [file] = await db
        .select()
        .from(caseFiles)
        .where(
          and(
            eq(caseFiles.id, input.fileId),
            eq(caseFiles.organizationId, input.organizationId),
            eq(caseFiles.caseId, input.caseId)
          )
        )
        .limit(1);
      if (!file) {
        throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
      }
      return {
        fileName: file.fileName,
        url: await storageGetSignedUrl(file.storageKey, file.fileName),
      };
    }),

  rerun: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:edit"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status !== "failed" && clinicalCase.status !== "review_ready") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Run again after analysis has finished or failed.",
        });
      }
      const db = await requireDb();
      const [latest] = await db
        .select({ manifest: analysisJobs.manifest })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.organizationId, input.organizationId),
            eq(analysisJobs.caseId, input.caseId)
          )
        )
        .orderBy(desc(analysisJobs.createdAt))
        .limit(1);
      const storedFilters = latest
        ? vcfFilterSchema.safeParse(
            (latest.manifest as { vcfFilters?: unknown }).vcfFilters
          )
        : null;
      const vcfFilters = storedFilters?.success ? storedFilters.data : null;
      const files = await db
        .select()
        .from(caseFiles)
        .where(
          and(
            eq(caseFiles.organizationId, input.organizationId),
            eq(caseFiles.caseId, input.caseId)
          )
        );
      const vcfFile = files.find(file => file.kind === "vcf");
      if (!vcfFile) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A VCF file is required",
        });
      }
      await db
        .delete(variants)
        .where(
          and(
            eq(variants.organizationId, input.organizationId),
            eq(variants.caseId, input.caseId)
          )
        );
      const idempotencyKey = randomUUID();
      const manifest = {
        schemaVersion: "1.0",
        serviceCode: "gvi_vcf_ingest",
        organizationId: input.organizationId,
        caseId: input.caseId,
        purpose: clinicalCase.purpose,
        referenceBuild: clinicalCase.referenceBuild,
        panelName: clinicalCase.panelName,
        files: files.map(file => ({
          id: file.id,
          kind: file.kind,
          storageKey: file.storageKey,
          sha256: file.sha256,
        })),
        vcfFilters,
      };
      const jobId = await db.transaction(async tx => {
        const result = await tx
          .insert(analysisJobs)
          .values({
            organizationId: input.organizationId,
            caseId: input.caseId,
            pipeline: "vcf_ingest",
            status: "queued",
            progressPercent: 0,
            idempotencyKey,
            manifest,
            createdBy: ctx.user.id,
          })
          .returning({ id: analysisJobs.id });
        const id = result[0].id;
        await tx.insert(analysisEvents).values({
          organizationId: input.organizationId,
          jobId: id,
          status: "queued",
          message: "Analysis rerun queued from the original VCF.",
          progressPercent: 0,
        });
        const cas = await tx
          .update(cases)
          .set({ status: "queued" })
          .where(
            and(
              eq(cases.id, input.caseId),
              eq(cases.organizationId, input.organizationId),
              inArray(cases.status, ["failed", "review_ready"])
            )
          )
          .returning({ id: cases.id });
        if (cas.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Run again after analysis has finished or failed.",
          });
        }
        return id;
      });
      const ingestArgs = {
        organizationId: input.organizationId,
        caseId: input.caseId,
        jobId,
        vcfFile,
        referenceBuild: clinicalCase.referenceBuild,
        purpose: clinicalCase.purpose,
        vcfFilters,
      };
      void ingestVcfForJob(ingestArgs).catch(error => {
        console.error("[vcf_ingest] background rerun failed", {
          caseId: input.caseId,
          jobId,
          error,
        });
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.rerun",
        entityType: "analysis_job",
        entityId: jobId,
        after: { caseId: input.caseId, idempotencyKey },
        req: ctx.req,
      });
      return { jobId };
    }),

  stop: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:edit"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status !== "queued" && clinicalCase.status !== "running") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a queued or running case can be stopped.",
        });
      }
      const db = await requireDb();
      const [job] = await db
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.organizationId, input.organizationId),
            eq(analysisJobs.caseId, input.caseId),
            inArray(analysisJobs.status, ["queued", "running"])
          )
        )
        .orderBy(desc(analysisJobs.createdAt))
        .limit(1);
      if (job) stoppedJobIds.add(job.id);
      const message = "Stopped by user.";
      await db.transaction(async tx => {
        if (job) {
          await tx
            .update(analysisJobs)
            .set({
              status: "failed",
              errorMessage: message,
              completedAt: new Date(),
            })
            .where(
              and(
                eq(analysisJobs.id, job.id),
                eq(analysisJobs.organizationId, input.organizationId),
                inArray(analysisJobs.status, ["queued", "running"])
              )
            );
          await tx.insert(analysisEvents).values({
            organizationId: input.organizationId,
            jobId: job.id,
            status: "failed",
            message,
            progressPercent: 0,
          });
        }
        const cas = await tx
          .update(cases)
          .set({ status: "failed" })
          .where(
            and(
              eq(cases.id, input.caseId),
              eq(cases.organizationId, input.organizationId),
              inArray(cases.status, ["queued", "running"])
            )
          )
          .returning({ id: cases.id });
        if (cas.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Only a queued or running case can be stopped.",
          });
        }
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.stopped",
        entityType: "case",
        entityId: input.caseId,
        after: { jobId: job?.id ?? null },
        req: ctx.req,
      });
      return { ok: true };
    }),

  resetTimeline: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:edit"
      );
      const clinicalCase = await requireCase(
        input.organizationId,
        input.caseId
      );
      if (clinicalCase.status === "queued" || clinicalCase.status === "running") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Stop the analysis before clearing its timeline.",
        });
      }
      const db = await requireDb();
      const jobs = await db
        .select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.organizationId, input.organizationId),
            eq(analysisJobs.caseId, input.caseId)
          )
        );
      const jobIds = jobs.map(job => job.id);
      if (jobIds.length) {
        await db
          .delete(analysisEvents)
          .where(
            and(
              eq(analysisEvents.organizationId, input.organizationId),
              inArray(analysisEvents.jobId, jobIds)
            )
          );
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.timeline.reset",
        entityType: "case",
        entityId: input.caseId,
        after: { jobs: jobIds.length },
        req: ctx.req,
      });
      return { ok: true };
    }),

  timeline: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      await requireCase(input.organizationId, input.caseId);
      const db = await requireDb();
      return db
        .select({
          id: analysisEvents.id,
          jobId: analysisEvents.jobId,
          status: analysisEvents.status,
          message: analysisEvents.message,
          progressPercent: analysisEvents.progressPercent,
          metadata: analysisEvents.metadata,
          createdAt: analysisEvents.createdAt,
        })
        .from(analysisEvents)
        .innerJoin(
          analysisJobs,
          and(
            eq(analysisJobs.id, analysisEvents.jobId),
            eq(analysisJobs.organizationId, analysisEvents.organizationId)
          )
        )
        .where(
          and(
            eq(analysisEvents.organizationId, input.organizationId),
            eq(analysisJobs.caseId, input.caseId)
          )
        )
        .orderBy(desc(analysisEvents.createdAt));
    }),
});

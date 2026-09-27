import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  caseFiles,
  cases,
  somaticAssayFindings,
  somaticCaseContexts,
  somaticCaseCoverageSummaries,
  somaticCaseRegionCoverage,
  somaticClinicalAssertions,
  somaticCivicImportCheckpoints,
  somaticCivicImportJobs,
  somaticCivicRawArchives,
  somaticGuidelineRecords,
  somaticInterpretationRuns,
  somaticKnowledgeEvidenceRecords,
  somaticKnowledgeProviders,
  somaticKnowledgeReleases,
  somaticOrganizationPolicyProfiles,
  somaticPanels,
  somaticPanelReportableRegions,
  somaticPanelVersions,
  somaticReinterpretationTasks,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import {
  parseBedReportableRegions,
  parseCoverageArtifact,
  sha256TextArtifact,
} from "../domain/somatic/artifactParsers";
import { parseAssayArtifact } from "../domain/somatic/assayArtifactParsers";
import {
  evaluateRegionCoverageMeasurement,
  evaluateRegionCoverageValidation,
} from "../domain/somatic/coverageValidation";
import {
  evaluateFindingReportability,
  evaluateKnowledgeActivation,
} from "../domain/somatic/foundationGates";
import {
  diffKnowledgeReleaseRecords,
  offlineEvidenceInsertValues,
  offlineKnowledgeEvidenceSchema,
} from "../domain/somatic/offlineKnowledge";
import {
  getOncoKbApiMetrics,
  oncoKbApiConfigFromEnv,
} from "../domain/somatic/oncokbApi";
import { guidelineRuleDefinitionSchema } from "../domain/somatic/rules";
import { validateNegativeReportingPolicy } from "../domain/somatic/policyValidation";
import { classifyPolicyImpact } from "../domain/somatic/policyImpact";
import { diffPanelRegions } from "../domain/somatic/panelImpact";
import {
  getMembership,
  requireDb,
  requireOrganizationPermission,
} from "../domain/tenant";
import { enqueueSomaticInterpretationRun } from "../domain/somatic/runEnqueue";
import { storagePut } from "../storage";
import {
  CIVIC_ADAPTER_VERSION,
  CIVIC_MATCHING_RULE_VERSION,
  CIVIC_NORMALIZATION_VERSION,
} from "../domain/somatic/civic/normalize";
import { CIVIC_QUERY_SET_SHA256 } from "../domain/somatic/civic/queries";

const organizationInput = z.object({
  organizationId: z.number().int().positive(),
});
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const jsonObject = z.record(z.string(), z.unknown());
const findingType = z.enum(["CNV", "FUSION", "MSI", "TMB", "HRD"]);
const findingStatus = z.enum([
  "detected",
  "not_detected",
  "not_tested",
  "indeterminate",
]);
const findingResult = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CNV"),
    gene: z.string().trim().min(1).max(80),
    copyNumber: z.number().nonnegative().optional(),
    log2Ratio: z.number().optional(),
    call: z.enum(["amplification", "gain", "loss", "deletion"]),
  }),
  z.object({
    type: z.literal("FUSION"),
    fivePrimeGene: z.string().trim().min(1).max(80),
    threePrimeGene: z.string().trim().min(1).max(80),
    inFrame: z.boolean().optional(),
    supportingReads: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("MSI"),
    score: z.number().optional(),
    category: z.enum(["stable", "low", "high", "indeterminate"]),
  }),
  z.object({
    type: z.literal("TMB"),
    mutationsPerMb: z.number().nonnegative(),
    category: z.enum(["low", "intermediate", "high"]).optional(),
  }),
  z.object({
    type: z.literal("HRD"),
    score: z.number().optional(),
    category: z.enum(["negative", "positive", "indeterminate"]),
    method: z.string().trim().min(1).max(200),
  }),
]);
const panelRegionImportRecord = z
  .object({
    regionKey: z.string().trim().min(1).max(240),
    regionType: z.enum([
      "gene",
      "exon",
      "interval",
      "fusion_pair",
      "signature",
    ]),
    findingType: findingType.nullable().optional(),
    gene: z.string().trim().min(1).max(80).nullable().optional(),
    transcript: z.string().trim().min(1).max(120).nullable().optional(),
    chromosome: z.string().trim().min(1).max(16).nullable().optional(),
    start: z.number().int().positive().nullable().optional(),
    end: z.number().int().positive().nullable().optional(),
    target: jsonObject.nullable().optional(),
    minimumDepth: z.number().int().nonnegative().nullable().optional(),
    minimumCoveragePercent: z.number().min(0).max(100).nullable().optional(),
    reportable: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      ["exon", "interval"].includes(value.regionType) &&
      (!value.chromosome ||
        value.start == null ||
        value.end == null ||
        value.end < value.start)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["start"],
        message:
          "Exon and interval regions require chromosome and an ordered coordinate range.",
      });
    }
    if (value.regionType === "fusion_pair" && value.findingType !== "FUSION") {
      ctx.addIssue({
        code: "custom",
        path: ["findingType"],
        message: "Fusion-pair regions must use FUSION finding type.",
      });
    }
  });
const coverageImportRecord = z.object({
  regionKey: z.string().trim().min(1).max(240),
  meanDepth: z.number().nonnegative().nullable(),
  coveredPercent: z.number().min(0).max(100).nullable(),
});
const assayImportRecord = z
  .object({
    findingType,
    status: findingStatus,
    result: findingResult.nullable(),
    sourceRunId: z.string().trim().min(1).max(160).nullable(),
    coverageSummaryId: z.number().int().positive().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.result && value.result.type !== value.findingType) {
      ctx.addIssue({
        code: "custom",
        path: ["result", "type"],
        message: "Finding result type must match findingType.",
      });
    }
    if (value.status === "detected" && !value.result) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "Detected findings require a typed result.",
      });
    }
  });
const normalizedVariantContextSchema = z
  .object({
    normalizedVariantId: z.string().trim().min(1).max(240),
    geneSymbol: z.string().trim().min(1).max(80),
    genomeBuild: z.string().trim().min(1).max(40).nullable().optional(),
    chromosome: z.string().trim().min(1).max(32).nullable().optional(),
    position: z.number().int().positive().nullable().optional(),
    ref: z.string().trim().min(1).max(10_000).nullable().optional(),
    alt: z.string().trim().min(1).max(10_000).nullable().optional(),
    transcript: z.string().trim().min(1).max(160).nullable().optional(),
    hgvsC: z.string().trim().min(1).max(500).nullable().optional(),
    hgvsP: z.string().trim().min(1).max(500).nullable().optional(),
    variantClass: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .strict();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredCivicSchemaHash(): string {
  const configured = process.env.CIVIC_SCHEMA_HASH?.trim().toLowerCase();
  return configured && /^[a-f0-9]{64}$/.test(configured)
    ? configured
    : hashText("CIViC GraphQL schema hash not configured");
}

async function requireCompletedCivicImportIfPresent(
  organizationId: number,
  releaseId: number
) {
  const db = await requireDb();
  const jobs = await db
    .select({ status: somaticCivicImportJobs.status })
    .from(somaticCivicImportJobs)
    .where(
      and(
        eq(somaticCivicImportJobs.organizationId, organizationId),
        eq(somaticCivicImportJobs.releaseId, releaseId)
      )
    )
    .orderBy(desc(somaticCivicImportJobs.createdAt))
    .limit(1);
  if (jobs[0] && jobs[0].status !== "complete") {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The latest CIViC import must complete before this release can be validated or activated.",
    });
  }
}

async function requireDraftRelease(organizationId: number, releaseId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(somaticKnowledgeReleases)
    .where(
      and(
        eq(somaticKnowledgeReleases.id, releaseId),
        eq(somaticKnowledgeReleases.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Release not found." });
  }
  if (rows[0].status !== "draft") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Only draft releases can be changed.",
    });
  }
  return rows[0];
}

async function requireSomaticCasePanel(
  organizationId: number,
  caseId: number,
  panelVersionId: number
) {
  const db = await requireDb();
  const rows = await db
    .select({ clinicalCase: cases, context: somaticCaseContexts })
    .from(cases)
    .innerJoin(
      somaticCaseContexts,
      and(
        eq(somaticCaseContexts.caseId, cases.id),
        eq(somaticCaseContexts.organizationId, cases.organizationId)
      )
    )
    .where(
      and(
        eq(cases.id, caseId),
        eq(cases.organizationId, organizationId),
        eq(cases.purpose, "somatic"),
        eq(somaticCaseContexts.panelVersionId, panelVersionId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Somatic case and matching panel context not found.",
    });
  }
  return rows[0];
}

async function requireMutablePanelRegions(
  organizationId: number,
  panelVersionId: number
) {
  const db = await requireDb();
  const [panelRows, coverageRows] = await Promise.all([
    db
      .select()
      .from(somaticPanelVersions)
      .where(
        and(
          eq(somaticPanelVersions.id, panelVersionId),
          eq(somaticPanelVersions.organizationId, organizationId)
        )
      )
      .limit(1),
    db
      .select({ value: count() })
      .from(somaticCaseCoverageSummaries)
      .where(
        and(
          eq(somaticCaseCoverageSummaries.organizationId, organizationId),
          eq(somaticCaseCoverageSummaries.panelVersionId, panelVersionId)
        )
      ),
  ]);
  const panel = panelRows[0];
  if (!panel) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Panel version not found.",
    });
  }
  if (
    panel.regionValidationStatus === "passed" ||
    (coverageRows[0]?.value ?? 0) > 0
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Panel regions are immutable after validation or case coverage capture. Create a new panel version.",
    });
  }
  return panel;
}

async function requireOrganizationAssignee(
  organizationId: number,
  userId?: number | null
) {
  if (userId == null) return;
  if (!(await getMembership(userId, organizationId))) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Task assignee is not an active organization member.",
    });
  }
}

function safeArtifactFileName(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}

async function persistSomaticArtifact(input: {
  organizationId: number;
  caseId: number;
  userId: number;
  fileName: string;
  artifactText: string;
  artifactHash: string;
  kind: "panel_bed" | "coverage" | "assay_result";
  mimeType: string;
}) {
  const computedHash = sha256TextArtifact(input.artifactText);
  if (computedHash !== input.artifactHash.toLowerCase()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Artifact SHA-256 does not match the exact uploaded text.",
    });
  }
  const fileName = safeArtifactFileName(input.fileName);
  if (!fileName) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Artifact file name is invalid.",
    });
  }
  const stored = await storagePut(
    `organizations/${input.organizationId}/cases/${input.caseId}/somatic-artifacts/${randomUUID()}-${fileName}`,
    input.artifactText,
    input.mimeType
  );
  const db = await requireDb();
  const rows = await db
    .insert(caseFiles)
    .values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      sampleId: null,
      kind: input.kind,
      fileName: input.fileName,
      storageKey: stored.key,
      storageUrl: stored.url,
      mimeType: input.mimeType,
      byteSize: Buffer.byteLength(input.artifactText, "utf8"),
      sha256: computedHash,
      status: "verified",
      uploadedBy: input.userId,
    })
    .returning();
  return rows[0];
}

async function buildReleaseImpact(
  organizationId: number,
  targetReleaseId: number
) {
  const db = await requireDb();
  const targetRows = await db
    .select({
      release: somaticKnowledgeReleases,
      provider: somaticKnowledgeProviders,
    })
    .from(somaticKnowledgeReleases)
    .innerJoin(
      somaticKnowledgeProviders,
      and(
        eq(somaticKnowledgeProviders.id, somaticKnowledgeReleases.providerId),
        eq(
          somaticKnowledgeProviders.organizationId,
          somaticKnowledgeReleases.organizationId
        )
      )
    )
    .where(
      and(
        eq(somaticKnowledgeReleases.id, targetReleaseId),
        eq(somaticKnowledgeReleases.organizationId, organizationId)
      )
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Release not found." });
  }
  const [activeRows, targetEvidence, guidelineCountRows, policyRows] =
    await Promise.all([
      db
        .select()
        .from(somaticKnowledgeReleases)
        .where(
          and(
            eq(somaticKnowledgeReleases.organizationId, organizationId),
            eq(somaticKnowledgeReleases.providerId, target.release.providerId),
            eq(somaticKnowledgeReleases.status, "active"),
            ne(somaticKnowledgeReleases.id, targetReleaseId)
          )
        )
        .limit(1),
      db
        .select({
          normalizedVariantId:
            somaticKnowledgeEvidenceRecords.normalizedVariantId,
          sourceRecordId: somaticKnowledgeEvidenceRecords.sourceRecordId,
          rawResponseHash: somaticKnowledgeEvidenceRecords.rawResponseHash,
        })
        .from(somaticKnowledgeEvidenceRecords)
        .where(
          and(
            eq(somaticKnowledgeEvidenceRecords.organizationId, organizationId),
            eq(somaticKnowledgeEvidenceRecords.releaseId, targetReleaseId)
          )
        ),
      db
        .select({ value: count() })
        .from(somaticGuidelineRecords)
        .where(
          and(
            eq(somaticGuidelineRecords.organizationId, organizationId),
            eq(somaticGuidelineRecords.releaseId, targetReleaseId)
          )
        ),
      db
        .select()
        .from(somaticOrganizationPolicyProfiles)
        .where(
          and(
            eq(
              somaticOrganizationPolicyProfiles.organizationId,
              organizationId
            ),
            eq(somaticOrganizationPolicyProfiles.status, "active")
          )
        )
        .limit(1),
    ]);
  const active = activeRows[0] ?? null;
  const previousEvidence = active
    ? await db
        .select({
          normalizedVariantId:
            somaticKnowledgeEvidenceRecords.normalizedVariantId,
          sourceRecordId: somaticKnowledgeEvidenceRecords.sourceRecordId,
          rawResponseHash: somaticKnowledgeEvidenceRecords.rawResponseHash,
        })
        .from(somaticKnowledgeEvidenceRecords)
        .where(
          and(
            eq(somaticKnowledgeEvidenceRecords.organizationId, organizationId),
            eq(somaticKnowledgeEvidenceRecords.releaseId, active.id)
          )
        )
    : [];
  const releaseDiff = diffKnowledgeReleaseRecords(
    previousEvidence,
    targetEvidence
  );
  const impactedRows = releaseDiff.impactedVariantIds.length
    ? await db
        .select({
          caseId: variants.caseId,
          normalizedVariantId: variants.normalizedId,
        })
        .from(variants)
        .innerJoin(
          cases,
          and(
            eq(cases.id, variants.caseId),
            eq(cases.organizationId, variants.organizationId)
          )
        )
        .where(
          and(
            eq(variants.organizationId, organizationId),
            eq(cases.purpose, "somatic"),
            inArray(variants.normalizedId, releaseDiff.impactedVariantIds)
          )
        )
    : [];
  const impactedByCase = new Map<number, Set<string>>();
  for (const row of impactedRows) {
    const ids = impactedByCase.get(row.caseId) ?? new Set<string>();
    ids.add(row.normalizedVariantId);
    impactedByCase.set(row.caseId, ids);
  }
  const gates = evaluateKnowledgeActivation({
    providerEnabled: target.provider.enabled,
    providerCode: target.provider.code,
    licenseStatus: target.provider.licenseStatus,
    licenseValidTo: target.provider.licenseValidTo,
    releaseValidationStatus: target.release.validationStatus,
    contentHash: target.release.contentHash,
    guidelineRecordCount: guidelineCountRows[0]?.value ?? 0,
    offlineEvidenceRecordCount: targetEvidence.length,
    policyEnablesOncoKb: policyRows[0]?.enableOncoKb ?? false,
  });
  return {
    target,
    active,
    gates,
    releaseDiff,
    impactedCases: Array.from(impactedByCase.entries())
      .map(([caseId, normalizedVariantIds]) => ({
        caseId,
        normalizedVariantIds: Array.from(normalizedVariantIds).sort(),
      }))
      .sort((a, b) => a.caseId - b.caseId),
    evidenceRecordCount: targetEvidence.length,
    guidelineRecordCount: guidelineCountRows[0]?.value ?? 0,
  };
}

async function buildPanelImpact(
  organizationId: number,
  previousPanelVersionId: number,
  targetPanelVersionId: number
) {
  if (previousPanelVersionId === targetPanelVersionId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Panel impact requires two different versions.",
    });
  }
  const db = await requireDb();
  const [versionRows, previousRegions, targetRegions, impactedCases] =
    await Promise.all([
      db
        .select({
          version: somaticPanelVersions,
          panelName: somaticPanels.name,
          manufacturer: somaticPanels.manufacturer,
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
        .where(
          and(
            eq(somaticPanelVersions.organizationId, organizationId),
            inArray(somaticPanelVersions.id, [
              previousPanelVersionId,
              targetPanelVersionId,
            ])
          )
        ),
      db
        .select()
        .from(somaticPanelReportableRegions)
        .where(
          and(
            eq(
              somaticPanelReportableRegions.organizationId,
              organizationId
            ),
            eq(
              somaticPanelReportableRegions.panelVersionId,
              previousPanelVersionId
            )
          )
        ),
      db
        .select()
        .from(somaticPanelReportableRegions)
        .where(
          and(
            eq(
              somaticPanelReportableRegions.organizationId,
              organizationId
            ),
            eq(
              somaticPanelReportableRegions.panelVersionId,
              targetPanelVersionId
            )
          )
        ),
      db
        .select({ caseId: somaticCaseContexts.caseId })
        .from(somaticCaseContexts)
        .innerJoin(
          cases,
          and(
            eq(cases.id, somaticCaseContexts.caseId),
            eq(cases.organizationId, somaticCaseContexts.organizationId)
          )
        )
        .where(
          and(
            eq(somaticCaseContexts.organizationId, organizationId),
            eq(
              somaticCaseContexts.panelVersionId,
              previousPanelVersionId
            ),
            eq(cases.purpose, "somatic")
          )
        ),
    ]);
  const previous = versionRows.find(
    row => row.version.id === previousPanelVersionId
  );
  const target = versionRows.find(
    row => row.version.id === targetPanelVersionId
  );
  if (!previous || !target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Panel version not found." });
  }
  if (previous.version.panelId !== target.version.panelId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Panel impact comparison requires versions of the same panel.",
    });
  }
  if (target.version.regionValidationStatus !== "passed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Target panel regions must pass validation first.",
    });
  }
  const regionDiff = diffPanelRegions(previousRegions, targetRegions);
  const capabilityChanges = Object.keys(target.version.capabilities)
    .filter(
      key =>
        previous.version.capabilities[
          key as keyof typeof previous.version.capabilities
        ] !==
        target.version.capabilities[
          key as keyof typeof target.version.capabilities
        ]
    )
    .sort();
  const metadataChanges = [
    previous.version.genomeBuild !== target.version.genomeBuild
      ? "genome_build"
      : null,
    previous.version.assayType !== target.version.assayType
      ? "assay_type"
      : null,
    previous.version.limitations !== target.version.limitations
      ? "limitations"
      : null,
    previous.version.regionArtifactHash !== target.version.regionArtifactHash
      ? "region_artifact"
      : null,
  ].filter((value): value is string => Boolean(value));
  const changeHash = createHash("sha256")
    .update(
      JSON.stringify({
        previousPanelVersionId,
        targetPanelVersionId,
        previousArtifactHash: previous.version.regionArtifactHash,
        targetArtifactHash: target.version.regionArtifactHash,
        capabilityChanges,
        metadataChanges,
        regionDiff,
      })
    )
    .digest("hex");
  return {
    previous,
    target,
    regionDiff,
    capabilityChanges,
    metadataChanges,
    hasChanges:
      capabilityChanges.length > 0 ||
      metadataChanges.length > 0 ||
      regionDiff.added.length > 0 ||
      regionDiff.removed.length > 0 ||
      regionDiff.changed.length > 0,
    changeHash,
    impactedCaseIds: impactedCases.map(row => row.caseId).sort((a, b) => a - b),
  };
}

async function buildAssayArtifactImpact(
  organizationId: number,
  caseId: number,
  targetArtifactFileId: number
) {
  const db = await requireDb();
  const [fileRows, findings] = await Promise.all([
    db
      .select()
      .from(caseFiles)
      .where(
        and(
          eq(caseFiles.id, targetArtifactFileId),
          eq(caseFiles.organizationId, organizationId),
          eq(caseFiles.caseId, caseId),
          eq(caseFiles.kind, "assay_result"),
          eq(caseFiles.status, "verified")
        )
      )
      .limit(1),
    db
      .select()
      .from(somaticAssayFindings)
      .where(
        and(
          eq(somaticAssayFindings.organizationId, organizationId),
          eq(somaticAssayFindings.caseId, caseId)
        )
      ),
  ]);
  const artifact = fileRows[0];
  if (!artifact) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Verified assay artifact not found.",
    });
  }
  const targetFindings = findings.filter(
    finding => finding.sourceArtifactFileId === targetArtifactFileId
  );
  if (!targetFindings.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The target artifact has no imported assay findings.",
    });
  }
  const targetTypes = new Set(
    targetFindings.map(finding => finding.findingType)
  );
  const supersededFindings = findings
    .filter(
      finding =>
        finding.reportable &&
        finding.sourceArtifactFileId !== targetArtifactFileId &&
        targetTypes.has(finding.findingType)
    )
    .sort((a, b) => a.id - b.id);
  const changeHash = createHash("sha256")
    .update(
      JSON.stringify({
        caseId,
        targetArtifactFileId,
        targetArtifactHash: artifact.sha256,
        targetFindingIds: targetFindings.map(finding => finding.id).sort(),
        supersededFindingIds: supersededFindings.map(finding => finding.id),
      })
    )
    .digest("hex");
  return {
    artifact,
    targetFindings,
    supersededFindings,
    changeHash,
  };
}

export const somaticFoundationRouter = router({
  list: protectedProcedure
    .input(organizationInput)
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const [
        providers,
        releases,
        guidelines,
        policies,
        evidenceCounts,
        civicImportJobs,
        panelVersions,
      ] = await Promise.all([
          db
            .select()
            .from(somaticKnowledgeProviders)
            .where(
              eq(somaticKnowledgeProviders.organizationId, input.organizationId)
            )
            .orderBy(asc(somaticKnowledgeProviders.name)),
          db
            .select()
            .from(somaticKnowledgeReleases)
            .where(
              eq(somaticKnowledgeReleases.organizationId, input.organizationId)
            )
            .orderBy(desc(somaticKnowledgeReleases.createdAt)),
          db
            .select()
            .from(somaticGuidelineRecords)
            .where(
              eq(somaticGuidelineRecords.organizationId, input.organizationId)
            )
            .orderBy(
              asc(somaticGuidelineRecords.releaseId),
              asc(somaticGuidelineRecords.recordKey)
            ),
          db
            .select()
            .from(somaticOrganizationPolicyProfiles)
            .where(
              eq(
                somaticOrganizationPolicyProfiles.organizationId,
                input.organizationId
              )
            )
            .orderBy(desc(somaticOrganizationPolicyProfiles.createdAt)),
          db
            .select({
              releaseId: somaticKnowledgeEvidenceRecords.releaseId,
              count: count(),
            })
            .from(somaticKnowledgeEvidenceRecords)
            .where(
              eq(
                somaticKnowledgeEvidenceRecords.organizationId,
                input.organizationId
              )
            )
            .groupBy(somaticKnowledgeEvidenceRecords.releaseId),
          db
            .select()
            .from(somaticCivicImportJobs)
            .where(
              eq(somaticCivicImportJobs.organizationId, input.organizationId)
            )
            .orderBy(desc(somaticCivicImportJobs.createdAt)),
          db
            .select({
              version: somaticPanelVersions,
              panelName: somaticPanels.name,
              manufacturer: somaticPanels.manufacturer,
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
            .where(
              eq(somaticPanelVersions.organizationId, input.organizationId)
            )
            .orderBy(
              asc(somaticPanels.name),
              desc(somaticPanelVersions.createdAt)
            ),
        ]);
      const oncoKbConfig = oncoKbApiConfigFromEnv();
      return {
        providers,
        releases,
        guidelines,
        policies,
        evidenceCounts,
        civicImportJobs,
        panelVersions,
        oncoKbRuntime: {
          mode: oncoKbConfig.mode,
          tokenConfigured: Boolean(oncoKbConfig.token),
          baseUrl: oncoKbConfig.baseUrl,
          batchSize: oncoKbConfig.batchSize,
          maxConcurrency: oncoKbConfig.maxConcurrency,
          requestTimeoutMs: oncoKbConfig.requestTimeoutMs,
          retryCount: oncoKbConfig.retryCount,
          cacheTtlMs: oncoKbConfig.cacheTtlMs,
          metrics: getOncoKbApiMetrics(),
        },
      };
    }),

  enqueueCivicImport: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
        scopeConfig: z.array(normalizedVariantContextSchema).min(1).max(10_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const releases = await db
        .select({
          release: somaticKnowledgeReleases,
          providerCode: somaticKnowledgeProviders.code,
        })
        .from(somaticKnowledgeReleases)
        .innerJoin(
          somaticKnowledgeProviders,
          and(
            eq(
              somaticKnowledgeProviders.id,
              somaticKnowledgeReleases.providerId
            ),
            eq(
              somaticKnowledgeProviders.organizationId,
              somaticKnowledgeReleases.organizationId
            )
          )
        )
        .where(
          and(
            eq(somaticKnowledgeReleases.id, input.releaseId),
            eq(
              somaticKnowledgeReleases.organizationId,
              input.organizationId
            )
          )
        )
        .limit(1);
      const target = releases[0];
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Release not found." });
      }
      if (
        target.release.status !== "draft" ||
        target.providerCode.trim().toUpperCase() !== "CIVIC"
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "CIViC imports require a draft release owned by the CIVIC provider.",
        });
      }
      const active = await db
        .select({ id: somaticCivicImportJobs.id })
        .from(somaticCivicImportJobs)
        .where(
          and(
            eq(somaticCivicImportJobs.organizationId, input.organizationId),
            eq(somaticCivicImportJobs.releaseId, input.releaseId),
            inArray(somaticCivicImportJobs.status, ["queued", "running"])
          )
        )
        .limit(1);
      if (active[0]) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An active CIViC import already exists for this release.",
        });
      }
      const snapshotHash = hashText(canonicalJson(input.scopeConfig));
      const adapterHash = hashText(
        [
          CIVIC_ADAPTER_VERSION,
          CIVIC_NORMALIZATION_VERSION,
          CIVIC_MATCHING_RULE_VERSION,
        ].join("\0")
      );
      let rows;
      try {
        rows = await db
          .insert(somaticCivicImportJobs)
          .values({
            organizationId: input.organizationId,
            releaseId: input.releaseId,
            scopeConfig: input.scopeConfig,
            snapshotHash,
            queryHash: CIVIC_QUERY_SET_SHA256,
            schemaHash: configuredCivicSchemaHash(),
            adapterHash,
            maxAttempts: Math.min(
              10,
              Math.max(
                1,
                Math.trunc(
                  Number(process.env.CIVIC_IMPORT_MAX_ATTEMPTS) || 3
                )
              )
            ),
            stats: {},
            warnings: [],
            requestedBy: ctx.user.id,
          })
          .returning();
      } catch {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An active CIViC import already exists for this release.",
        });
      }
      await db
        .update(somaticKnowledgeReleases)
        .set({
          validationStatus: "pending",
          validationSummary: null,
          validatedBy: null,
          validatedAt: null,
        })
        .where(
          and(
            eq(somaticKnowledgeReleases.id, input.releaseId),
            eq(
              somaticKnowledgeReleases.organizationId,
              input.organizationId
            ),
            eq(somaticKnowledgeReleases.status, "draft")
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.civic_import.enqueued",
        entityType: "somatic_civic_import_job",
        entityId: rows[0].id,
        after: {
          releaseId: input.releaseId,
          scopeCount: input.scopeConfig.length,
          snapshotHash,
          queryHash: CIVIC_QUERY_SET_SHA256,
          schemaHash: rows[0].schemaHash,
          adapterHash,
        },
        req: ctx.req,
      });
      return rows[0];
    }),

  getCivicImport: protectedProcedure
    .input(
      organizationInput.extend({
        jobId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const jobs = await db
        .select()
        .from(somaticCivicImportJobs)
        .where(
          and(
            eq(somaticCivicImportJobs.id, input.jobId),
            eq(somaticCivicImportJobs.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!jobs[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "CIViC import job not found.",
        });
      }
      const [checkpoints, archives] = await Promise.all([
        db
          .select()
          .from(somaticCivicImportCheckpoints)
          .where(
            and(
              eq(
                somaticCivicImportCheckpoints.organizationId,
                input.organizationId
              ),
              eq(somaticCivicImportCheckpoints.jobId, input.jobId)
            )
          )
          .orderBy(
            asc(somaticCivicImportCheckpoints.scopeIndex),
            asc(somaticCivicImportCheckpoints.createdAt)
          ),
        db
          .select()
          .from(somaticCivicRawArchives)
          .where(
            and(
              eq(somaticCivicRawArchives.organizationId, input.organizationId),
              eq(somaticCivicRawArchives.jobId, input.jobId)
            )
          )
          .orderBy(asc(somaticCivicRawArchives.createdAt)),
      ]);
      return { job: jobs[0], checkpoints, archives };
    }),

  cancelCivicImport: protectedProcedure
    .input(
      organizationInput.extend({
        jobId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const jobs = await db
        .select()
        .from(somaticCivicImportJobs)
        .where(
          and(
            eq(somaticCivicImportJobs.id, input.jobId),
            eq(somaticCivicImportJobs.organizationId, input.organizationId)
          )
        )
        .limit(1);
      const before = jobs[0];
      if (!before) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "CIViC import job not found.",
        });
      }
      if (!["queued", "running", "partial"].includes(before.status)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only queued, running, or partial CIViC imports can be cancelled.",
        });
      }
      const now = new Date();
      const rows = await db
        .update(somaticCivicImportJobs)
        .set(
          before.status === "running"
            ? {
                cancelRequestedAt: now,
                cancelRequestedBy: ctx.user.id,
              }
            : {
                status: "cancelled",
                cancelRequestedAt: now,
                cancelRequestedBy: ctx.user.id,
                completedAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
              }
        )
        .where(
          and(
            eq(somaticCivicImportJobs.id, input.jobId),
            eq(somaticCivicImportJobs.organizationId, input.organizationId),
            eq(somaticCivicImportJobs.status, before.status)
          )
        )
        .returning();
      if (!rows[0]) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "CIViC import state changed; retry cancellation.",
        });
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.civic_import.cancelled",
        entityType: "somatic_civic_import_job",
        entityId: input.jobId,
        before,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  previewReleaseImpact: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const impact = await buildReleaseImpact(
        input.organizationId,
        input.releaseId
      );
      return {
        targetRelease: impact.target.release,
        currentRelease: impact.active,
        gates: impact.gates,
        releaseDiff: impact.releaseDiff,
        impactedCases: impact.impactedCases,
        evidenceRecordCount: impact.evidenceRecordCount,
        guidelineRecordCount: impact.guidelineRecordCount,
      };
    }),

  previewPanelImpact: protectedProcedure
    .input(
      organizationInput.extend({
        previousPanelVersionId: z.number().int().positive(),
        targetPanelVersionId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      return buildPanelImpact(
        input.organizationId,
        input.previousPanelVersionId,
        input.targetPanelVersionId
      );
    }),

  createPanelImpactTasks: protectedProcedure
    .input(
      organizationInput.extend({
        previousPanelVersionId: z.number().int().positive(),
        targetPanelVersionId: z.number().int().positive(),
        expectedChangeHash: sha256,
        changeControlId: z.string().trim().min(3).max(160),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const impact = await buildPanelImpact(
        input.organizationId,
        input.previousPanelVersionId,
        input.targetPanelVersionId
      );
      if (impact.changeHash !== input.expectedChangeHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Panel definition changed after preview; review it again.",
        });
      }
      if (!impact.hasChanges) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No material panel changes require reinterpretation.",
        });
      }
      const db = await requireDb();
      const releases = await db
        .select()
        .from(somaticKnowledgeReleases)
        .where(
          and(
            eq(somaticKnowledgeReleases.organizationId, input.organizationId),
            eq(somaticKnowledgeReleases.status, "active"),
            eq(somaticKnowledgeReleases.validationStatus, "passed")
          )
        )
        .orderBy(desc(somaticKnowledgeReleases.activatedAt))
        .limit(1);
      const release = releases[0];
      if (!release) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "An active validated knowledge release is required for panel reinterpretation.",
        });
      }
      const created = impact.impactedCaseIds.length
        ? await db
            .insert(somaticReinterpretationTasks)
            .values(
              impact.impactedCaseIds.map(caseId => ({
                organizationId: input.organizationId,
                caseId,
                releaseId: release.id,
                findingId: null,
                changeKind: "panel_version",
                changeKey: `panel:${input.previousPanelVersionId}:${input.targetPanelVersionId}`,
                reason: `Panel ${impact.target.panelName} changed from ${impact.previous.version.version} to ${impact.target.version.version}.`,
                impact: {
                  kind: "panel_version",
                  changeControlId: input.changeControlId,
                  changeHash: impact.changeHash,
                  previousPanelVersionId: input.previousPanelVersionId,
                  previousVersion: impact.previous.version.version,
                  previousArtifactHash:
                    impact.previous.version.regionArtifactHash,
                  targetPanelVersionId: input.targetPanelVersionId,
                  targetVersion: impact.target.version.version,
                  targetArtifactHash: impact.target.version.regionArtifactHash,
                  capabilityChanges: impact.capabilityChanges,
                  metadataChanges: impact.metadataChanges,
                  regionDiff: impact.regionDiff,
                },
                previousReleaseVersion: release.version,
                targetReleaseVersion: release.version,
                createdBy: ctx.user.id,
              }))
            )
            .onConflictDoNothing()
            .returning({ id: somaticReinterpretationTasks.id })
        : [];
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.panel_impact.tasks_created",
        entityType: "somatic_panel_version",
        entityId: input.targetPanelVersionId,
        after: {
          changeControlId: input.changeControlId,
          changeHash: impact.changeHash,
          impactedCaseCount: impact.impactedCaseIds.length,
          createdTaskCount: created.length,
        },
        req: ctx.req,
      });
      return {
        impactedCaseCount: impact.impactedCaseIds.length,
        createdTaskCount: created.length,
      };
    }),

  createProvider: protectedProcedure
    .input(
      organizationInput.extend({
        code: z.string().trim().min(2).max(80),
        name: z.string().trim().min(2).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const rows = await db
        .insert(somaticKnowledgeProviders)
        .values({
          organizationId: input.organizationId,
          code: input.code,
          name: input.name,
          enabled: false,
          licenseStatus: "unconfigured",
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.provider.created",
        entityType: "somatic_knowledge_provider",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  configureProviderLicense: protectedProcedure
    .input(
      organizationInput.extend({
        providerId: z.number().int().positive(),
        enabled: z.boolean(),
        licenseStatus: z.enum([
          "unconfigured",
          "approved",
          "restricted",
          "expired",
        ]),
        licenseReference: z.string().trim().min(3).max(500).nullable(),
        licenseValidFrom: z.coerce.date().nullable(),
        licenseValidTo: z.coerce.date().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      if (
        input.enabled &&
        (input.licenseStatus !== "approved" || !input.licenseReference)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Enabling a provider requires an approved, referenced license.",
        });
      }
      const db = await requireDb();
      const before = await db
        .select()
        .from(somaticKnowledgeProviders)
        .where(
          and(
            eq(somaticKnowledgeProviders.id, input.providerId),
            eq(somaticKnowledgeProviders.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!before[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Provider not found.",
        });
      }
      const rows = await db
        .update(somaticKnowledgeProviders)
        .set({
          enabled: input.enabled,
          licenseStatus: input.licenseStatus,
          licenseReference: input.licenseReference,
          licenseValidFrom: input.licenseValidFrom,
          licenseValidTo: input.licenseValidTo,
          licenseApprovedBy:
            input.licenseStatus === "approved" ? ctx.user.id : null,
          licenseApprovedAt:
            input.licenseStatus === "approved" ? new Date() : null,
        })
        .where(
          and(
            eq(somaticKnowledgeProviders.id, input.providerId),
            eq(somaticKnowledgeProviders.organizationId, input.organizationId)
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.provider.license_configured",
        entityType: "somatic_knowledge_provider",
        entityId: input.providerId,
        before: before[0],
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  createRelease: protectedProcedure
    .input(
      organizationInput.extend({
        providerId: z.number().int().positive(),
        version: z.string().trim().min(1).max(120),
        contentHash: sha256,
        sourcePublishedAt: z.coerce.date().nullable().optional(),
        changeControlId: z.string().trim().min(3).max(120),
        changeSummary: z.string().trim().min(10).max(8000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const provider = await db
        .select({ id: somaticKnowledgeProviders.id })
        .from(somaticKnowledgeProviders)
        .where(
          and(
            eq(somaticKnowledgeProviders.id, input.providerId),
            eq(somaticKnowledgeProviders.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!provider[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Provider not found.",
        });
      }
      const rows = await db
        .insert(somaticKnowledgeReleases)
        .values({
          organizationId: input.organizationId,
          providerId: input.providerId,
          version: input.version,
          contentHash: input.contentHash.toLowerCase(),
          sourcePublishedAt: input.sourcePublishedAt,
          changeControlId: input.changeControlId,
          changeSummary: input.changeSummary,
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.knowledge_release.created",
        entityType: "somatic_knowledge_release",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  addGuidelineRecord: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
        recordKey: z.string().trim().min(1).max(200),
        recordVersion: z.number().int().positive().default(1),
        title: z.string().trim().min(3).max(500),
        guideline: guidelineRuleDefinitionSchema,
        sourceCitation: z.string().trim().min(3).max(1000),
        effectiveFrom: z.coerce.date().nullable().optional(),
        effectiveTo: z.coerce.date().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireDraftRelease(input.organizationId, input.releaseId);
      const db = await requireDb();
      const rows = await db
        .insert(somaticGuidelineRecords)
        .values({
          organizationId: input.organizationId,
          releaseId: input.releaseId,
          recordKey: input.recordKey,
          recordVersion: input.recordVersion,
          title: input.title,
          guideline: input.guideline,
          sourceCitation: input.sourceCitation,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.guideline_record.created",
        entityType: "somatic_guideline_record",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  importReleaseEvidence: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
        records: z.array(offlineKnowledgeEvidenceSchema).min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireDraftRelease(input.organizationId, input.releaseId);
      const db = await requireDb();
      const rows = await db
        .insert(somaticKnowledgeEvidenceRecords)
        .values(
          input.records.map(record =>
            offlineEvidenceInsertValues(
              input.organizationId,
              input.releaseId,
              record
            )
          )
        )
        .returning({ id: somaticKnowledgeEvidenceRecords.id });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.knowledge_release.evidence_imported",
        entityType: "somatic_knowledge_release",
        entityId: input.releaseId,
        after: {
          importedRecordCount: rows.length,
          recordIds: rows.map(row => row.id),
        },
        req: ctx.req,
      });
      return { importedRecordCount: rows.length };
    }),

  recordReleaseValidation: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
        validationStatus: z.enum(["passed", "failed"]),
        validationSummary: jsonObject,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const before = await requireDraftRelease(
        input.organizationId,
        input.releaseId
      );
      await requireCompletedCivicImportIfPresent(
        input.organizationId,
        input.releaseId
      );
      const db = await requireDb();
      const rows = await db
        .update(somaticKnowledgeReleases)
        .set({
          validationStatus: input.validationStatus,
          validationSummary: input.validationSummary,
          validatedBy: ctx.user.id,
          validatedAt: new Date(),
        })
        .where(
          and(
            eq(somaticKnowledgeReleases.id, input.releaseId),
            eq(somaticKnowledgeReleases.organizationId, input.organizationId),
            eq(somaticKnowledgeReleases.status, "draft")
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.knowledge_release.validated",
        entityType: "somatic_knowledge_release",
        entityId: input.releaseId,
        before,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  activateRelease: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const db = await requireDb();
      const releaseRows = await db
        .select({
          release: somaticKnowledgeReleases,
          provider: somaticKnowledgeProviders,
        })
        .from(somaticKnowledgeReleases)
        .innerJoin(
          somaticKnowledgeProviders,
          and(
            eq(
              somaticKnowledgeProviders.id,
              somaticKnowledgeReleases.providerId
            ),
            eq(
              somaticKnowledgeProviders.organizationId,
              somaticKnowledgeReleases.organizationId
            )
          )
        )
        .where(
          and(
            eq(somaticKnowledgeReleases.id, input.releaseId),
            eq(somaticKnowledgeReleases.organizationId, input.organizationId)
          )
        )
        .limit(1);
      const record = releaseRows[0];
      if (!record) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Release not found.",
        });
      }
      await requireCompletedCivicImportIfPresent(
        input.organizationId,
        input.releaseId
      );
      if (record.release.status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a draft release can be activated.",
        });
      }
      const [
        guidelineCountRows,
        evidenceCountRows,
        policyRows,
        previousReleaseRows,
      ] = await Promise.all([
        db
          .select({ value: count() })
          .from(somaticGuidelineRecords)
          .where(
            and(
              eq(somaticGuidelineRecords.organizationId, input.organizationId),
              eq(somaticGuidelineRecords.releaseId, input.releaseId)
            )
          ),
        db
          .select({ value: count() })
          .from(somaticKnowledgeEvidenceRecords)
          .where(
            and(
              eq(
                somaticKnowledgeEvidenceRecords.organizationId,
                input.organizationId
              ),
              eq(somaticKnowledgeEvidenceRecords.releaseId, input.releaseId)
            )
          ),
        db
          .select()
          .from(somaticOrganizationPolicyProfiles)
          .where(
            and(
              eq(
                somaticOrganizationPolicyProfiles.organizationId,
                input.organizationId
              ),
              eq(somaticOrganizationPolicyProfiles.status, "active")
            )
          )
          .limit(1),
        db
          .select()
          .from(somaticKnowledgeReleases)
          .where(
            and(
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(
                somaticKnowledgeReleases.providerId,
                record.release.providerId
              ),
              eq(somaticKnowledgeReleases.status, "active"),
              ne(somaticKnowledgeReleases.id, input.releaseId)
            )
          )
          .limit(1),
      ]);
      const decision = evaluateKnowledgeActivation({
        providerEnabled: record.provider.enabled,
        providerCode: record.provider.code,
        licenseStatus: record.provider.licenseStatus,
        licenseValidTo: record.provider.licenseValidTo,
        releaseValidationStatus: record.release.validationStatus,
        contentHash: record.release.contentHash,
        guidelineRecordCount: guidelineCountRows[0]?.value ?? 0,
        offlineEvidenceRecordCount: evidenceCountRows[0]?.value ?? 0,
        policyEnablesOncoKb: policyRows[0]?.enableOncoKb ?? false,
      });
      if (!decision.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Activation gates failed: ${decision.reasons.join(", ")}`,
        });
      }
      const previousRelease = previousReleaseRows[0] ?? null;
      const [previousEvidence, targetEvidence] = await Promise.all([
        previousRelease
          ? db
              .select({
                normalizedVariantId:
                  somaticKnowledgeEvidenceRecords.normalizedVariantId,
                sourceRecordId: somaticKnowledgeEvidenceRecords.sourceRecordId,
                rawResponseHash:
                  somaticKnowledgeEvidenceRecords.rawResponseHash,
              })
              .from(somaticKnowledgeEvidenceRecords)
              .where(
                and(
                  eq(
                    somaticKnowledgeEvidenceRecords.organizationId,
                    input.organizationId
                  ),
                  eq(
                    somaticKnowledgeEvidenceRecords.releaseId,
                    previousRelease.id
                  )
                )
              )
          : Promise.resolve([]),
        db
          .select({
            normalizedVariantId:
              somaticKnowledgeEvidenceRecords.normalizedVariantId,
            sourceRecordId: somaticKnowledgeEvidenceRecords.sourceRecordId,
            rawResponseHash: somaticKnowledgeEvidenceRecords.rawResponseHash,
          })
          .from(somaticKnowledgeEvidenceRecords)
          .where(
            and(
              eq(
                somaticKnowledgeEvidenceRecords.organizationId,
                input.organizationId
              ),
              eq(somaticKnowledgeEvidenceRecords.releaseId, input.releaseId)
            )
          ),
      ]);
      const releaseDiff = diffKnowledgeReleaseRecords(
        previousEvidence,
        targetEvidence
      );
      const impactedRows =
        previousRelease && releaseDiff.impactedVariantIds.length
          ? await db
              .select({
                caseId: variants.caseId,
                normalizedVariantId: variants.normalizedId,
              })
              .from(variants)
              .innerJoin(
                cases,
                and(
                  eq(cases.id, variants.caseId),
                  eq(cases.organizationId, variants.organizationId)
                )
              )
              .where(
                and(
                  eq(variants.organizationId, input.organizationId),
                  eq(cases.purpose, "somatic"),
                  inArray(variants.normalizedId, releaseDiff.impactedVariantIds)
                )
              )
          : [];
      const impactedByCase = new Map<number, Set<string>>();
      for (const row of impactedRows) {
        const ids = impactedByCase.get(row.caseId) ?? new Set<string>();
        ids.add(row.normalizedVariantId);
        impactedByCase.set(row.caseId, ids);
      }
      const activatedAt = new Date();
      await db.transaction(async tx => {
        await tx
          .update(somaticKnowledgeReleases)
          .set({
            status: "retired",
            retiredBy: ctx.user.id,
            retiredAt: activatedAt,
          })
          .where(
            and(
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(
                somaticKnowledgeReleases.providerId,
                record.release.providerId
              ),
              eq(somaticKnowledgeReleases.status, "active"),
              ne(somaticKnowledgeReleases.id, input.releaseId)
            )
          );
        await tx
          .update(somaticKnowledgeReleases)
          .set({
            status: "active",
            activatedBy: ctx.user.id,
            activatedAt,
          })
          .where(
            and(
              eq(somaticKnowledgeReleases.id, input.releaseId),
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(somaticKnowledgeReleases.status, "draft")
            )
          );
        if (previousRelease && impactedByCase.size) {
          await tx
            .insert(somaticReinterpretationTasks)
            .values(
              Array.from(impactedByCase.entries()).map(
                ([caseId, normalizedVariantIds]) => ({
                  organizationId: input.organizationId,
                  caseId,
                  releaseId: input.releaseId,
                  findingId: null,
                  reason: `Offline ${record.provider.code} release changed evidence for ${normalizedVariantIds.size} case variant(s).`,
                  impact: {
                    ...releaseDiff,
                    normalizedVariantIds:
                      Array.from(normalizedVariantIds).sort(),
                  },
                  previousReleaseVersion: previousRelease.version,
                  targetReleaseVersion: record.release.version,
                  createdBy: ctx.user.id,
                })
              )
            )
            .onConflictDoNothing();
        }
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.knowledge_release.activated",
        entityType: "somatic_knowledge_release",
        entityId: input.releaseId,
        before: record.release,
        after: {
          status: "active",
          activatedAt,
          gates: decision,
          releaseDiff,
          reinterpretationTaskCount: impactedByCase.size,
        },
        req: ctx.req,
      });
      return {
        activated: true,
        gates: decision,
        releaseDiff,
        reinterpretationTaskCount: impactedByCase.size,
      };
    }),

  rollbackRelease: protectedProcedure
    .input(
      organizationInput.extend({
        releaseId: z.number().int().positive(),
        changeControlId: z.string().trim().min(3).max(120),
        reason: z.string().trim().min(10).max(8000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const impact = await buildReleaseImpact(
        input.organizationId,
        input.releaseId
      );
      if (impact.target.release.status !== "retired") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a validated retired release can be restored.",
        });
      }
      if (!impact.active) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No active release exists to roll back.",
        });
      }
      if (!impact.gates.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Rollback gates failed: ${impact.gates.reasons.join(", ")}`,
        });
      }
      const db = await requireDb();
      const changedAt = new Date();
      await db.transaction(async tx => {
        const retired = await tx
          .update(somaticKnowledgeReleases)
          .set({
            status: "retired",
            retiredBy: ctx.user.id,
            retiredAt: changedAt,
          })
          .where(
            and(
              eq(somaticKnowledgeReleases.id, impact.active!.id),
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(somaticKnowledgeReleases.status, "active")
            )
          )
          .returning({ id: somaticKnowledgeReleases.id });
        if (retired.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The active release changed during rollback.",
          });
        }
        const restored = await tx
          .update(somaticKnowledgeReleases)
          .set({
            status: "active",
            activatedBy: ctx.user.id,
            activatedAt: changedAt,
            retiredBy: null,
            retiredAt: null,
          })
          .where(
            and(
              eq(somaticKnowledgeReleases.id, input.releaseId),
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(somaticKnowledgeReleases.status, "retired")
            )
          )
          .returning({ id: somaticKnowledgeReleases.id });
        if (restored.length !== 1) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The rollback target is no longer retired.",
          });
        }
        if (impact.impactedCases.length) {
          await tx
            .insert(somaticReinterpretationTasks)
            .values(
              impact.impactedCases.map(item => ({
                organizationId: input.organizationId,
                caseId: item.caseId,
                releaseId: input.releaseId,
                findingId: null,
                reason: `Controlled rollback ${impact.active!.version} → ${impact.target.release.version}: ${input.reason}`,
                impact: {
                  kind: "release_rollback",
                  changeControlId: input.changeControlId,
                  ...impact.releaseDiff,
                  normalizedVariantIds: item.normalizedVariantIds,
                },
                previousReleaseVersion: impact.active!.version,
                targetReleaseVersion: impact.target.release.version,
                createdBy: ctx.user.id,
              }))
            )
            .onConflictDoNothing();
        }
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.knowledge_release.rolled_back",
        entityType: "somatic_knowledge_release",
        entityId: input.releaseId,
        before: {
          activeReleaseId: impact.active.id,
          activeVersion: impact.active.version,
          targetStatus: impact.target.release.status,
        },
        after: {
          activeReleaseId: input.releaseId,
          activeVersion: impact.target.release.version,
          changeControlId: input.changeControlId,
          reason: input.reason,
          releaseDiff: impact.releaseDiff,
          reinterpretationTaskCount: impact.impactedCases.length,
        },
        req: ctx.req,
      });
      return {
        rolledBack: true,
        releaseDiff: impact.releaseDiff,
        reinterpretationTaskCount: impact.impactedCases.length,
      };
    }),

  createPolicyProfile: protectedProcedure
    .input(
      organizationInput.extend({
        name: z.string().trim().min(2).max(160),
        version: z.number().int().positive(),
        allowNegativeReporting: z.boolean().default(false),
        enableOncoKb: z.boolean().default(false),
        policy: jsonObject,
        contentHash: sha256,
        changeControlId: z.string().trim().min(3).max(120),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const rows = await db
        .insert(somaticOrganizationPolicyProfiles)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          version: input.version,
          allowNegativeReporting: input.allowNegativeReporting,
          enableOncoKb: input.enableOncoKb,
          policy: input.policy,
          contentHash: input.contentHash.toLowerCase(),
          changeControlId: input.changeControlId,
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.policy_profile.created",
        entityType: "somatic_organization_policy_profile",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  activatePolicyProfile: protectedProcedure
    .input(
      organizationInput.extend({
        policyProfileId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const db = await requireDb();
      const rows = await db
        .select()
        .from(somaticOrganizationPolicyProfiles)
        .where(
          and(
            eq(somaticOrganizationPolicyProfiles.id, input.policyProfileId),
            eq(
              somaticOrganizationPolicyProfiles.organizationId,
              input.organizationId
            )
          )
        )
        .limit(1);
      if (!rows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Policy not found.",
        });
      }
      if (rows[0].status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a draft policy can be activated.",
        });
      }
      const negativeReportingValidation = validateNegativeReportingPolicy(
        rows[0].allowNegativeReporting,
        rows[0].policy
      );
      if (!negativeReportingValidation.valid) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Negative reporting requires policy.negativeReportingValidationArtifactHash to contain a valid SHA-256 validation artifact hash.",
        });
      }
      const [previousPolicies, activeReleases, somaticCases] = await Promise.all([
        db
          .select()
          .from(somaticOrganizationPolicyProfiles)
          .where(
            and(
              eq(
                somaticOrganizationPolicyProfiles.organizationId,
                input.organizationId
              ),
              eq(somaticOrganizationPolicyProfiles.status, "active")
            )
          )
          .limit(1),
        db
          .select()
          .from(somaticKnowledgeReleases)
          .where(
            and(
              eq(somaticKnowledgeReleases.organizationId, input.organizationId),
              eq(somaticKnowledgeReleases.status, "active"),
              eq(somaticKnowledgeReleases.validationStatus, "passed")
            )
          )
          .orderBy(desc(somaticKnowledgeReleases.activatedAt))
          .limit(1),
        db
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.organizationId, input.organizationId),
              eq(cases.purpose, "somatic")
            )
          ),
      ]);
      const previousPolicy = previousPolicies[0] ?? null;
      const activeRelease = activeReleases[0] ?? null;
      const policyImpact = classifyPolicyImpact(previousPolicy, rows[0]);
      const policyChanged = policyImpact.changed;
      const impactKind = policyImpact.changedControls;
      const activatedAt = new Date();
      let policyImpactTaskCount = 0;
      await db.transaction(async tx => {
        await tx
          .update(somaticOrganizationPolicyProfiles)
          .set({ status: "retired" })
          .where(
            and(
              eq(
                somaticOrganizationPolicyProfiles.organizationId,
                input.organizationId
              ),
              eq(somaticOrganizationPolicyProfiles.status, "active")
            )
          );
        await tx
          .update(somaticOrganizationPolicyProfiles)
          .set({
            status: "active",
            approvedBy: ctx.user.id,
            approvedAt: activatedAt,
            activatedBy: ctx.user.id,
            activatedAt,
          })
          .where(
            and(
              eq(somaticOrganizationPolicyProfiles.id, input.policyProfileId),
              eq(
                somaticOrganizationPolicyProfiles.organizationId,
                input.organizationId
              ),
              eq(somaticOrganizationPolicyProfiles.status, "draft")
            )
          );
        if (
          policyChanged &&
          activeRelease &&
          somaticCases.length > 0
        ) {
          const createdTasks = await tx
            .insert(somaticReinterpretationTasks)
            .values(
              somaticCases.map(clinicalCase => ({
                organizationId: input.organizationId,
                caseId: clinicalCase.id,
                releaseId: activeRelease.id,
                findingId: null,
                changeKind: "policy_profile",
                changeKey: `policy:${input.policyProfileId}`,
                reason: `Organization Somatic policy changed from ${previousPolicy!.name} v${previousPolicy!.version} to ${rows[0].name} v${rows[0].version}.`,
                impact: {
                  kind: "policy_profile",
                  changedControls: impactKind,
                  previousPolicyId: previousPolicy!.id,
                  previousPolicyVersion: previousPolicy!.version,
                  previousContentHash: previousPolicy!.contentHash,
                  targetPolicyId: rows[0].id,
                  targetPolicyVersion: rows[0].version,
                  targetContentHash: rows[0].contentHash,
                },
                previousReleaseVersion: activeRelease.version,
                targetReleaseVersion: activeRelease.version,
                createdBy: ctx.user.id,
              }))
            )
            .onConflictDoNothing()
            .returning({ id: somaticReinterpretationTasks.id });
          policyImpactTaskCount = createdTasks.length;
        }
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.policy_profile.activated",
        entityType: "somatic_organization_policy_profile",
        entityId: input.policyProfileId,
        before: rows[0],
        after: {
          ...rows[0],
          status: "active",
          activatedAt,
          negativeReportingValidation,
          policyImpactTaskCount,
          changedControls: impactKind,
        },
        req: ctx.req,
      });
      return {
        activated: true,
        policyImpactTaskCount,
        changedControls: impactKind,
      };
    }),

  stagePanelBedArtifact: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        panelVersionId: z.number().int().positive(),
        fileName: z.string().trim().min(1).max(255),
        artifactText: z.string().min(1).max(20_000_000),
        artifactHash: sha256,
        minimumDepth: z.number().int().nonnegative().nullable(),
        minimumCoveragePercent: z.number().min(0).max(100).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      await requireMutablePanelRegions(
        input.organizationId,
        input.panelVersionId
      );
      let regions;
      try {
        regions = parseBedReportableRegions(input.artifactText, {
          minimumDepth: input.minimumDepth,
          minimumCoveragePercent: input.minimumCoveragePercent,
        });
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error ? error.message : "BED artifact is invalid.",
        });
      }
      const file = await persistSomaticArtifact({
        organizationId: input.organizationId,
        caseId: input.caseId,
        userId: ctx.user.id,
        fileName: input.fileName,
        artifactText: input.artifactText,
        artifactHash: input.artifactHash,
        kind: "panel_bed",
        mimeType: "text/tab-separated-values",
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.panel_bed.staged",
        entityType: "case_file",
        entityId: file.id,
        after: {
          caseId: input.caseId,
          panelVersionId: input.panelVersionId,
          artifactHash: file.sha256,
          regionCount: regions.length,
        },
        req: ctx.req,
      });
      return { file, regions };
    }),

  stageCoverageArtifact: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        panelVersionId: z.number().int().positive(),
        fileName: z.string().trim().min(1).max(255),
        artifactText: z.string().min(1).max(20_000_000),
        artifactHash: sha256,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      let records;
      try {
        records = parseCoverageArtifact(input.artifactText);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "Coverage artifact is invalid.",
        });
      }
      const file = await persistSomaticArtifact({
        organizationId: input.organizationId,
        caseId: input.caseId,
        userId: ctx.user.id,
        fileName: input.fileName,
        artifactText: input.artifactText,
        artifactHash: input.artifactHash,
        kind: "coverage",
        mimeType: input.fileName.toLowerCase().endsWith(".json")
          ? "application/json"
          : "text/tab-separated-values",
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.coverage_artifact.staged",
        entityType: "case_file",
        entityId: file.id,
        after: {
          caseId: input.caseId,
          panelVersionId: input.panelVersionId,
          artifactHash: file.sha256,
          recordCount: records.length,
        },
        req: ctx.req,
      });
      return { file, records };
    }),

  listPanelRegions: protectedProcedure
    .input(
      organizationInput.extend({
        panelVersionId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const panel = await db
        .select({ id: somaticPanelVersions.id })
        .from(somaticPanelVersions)
        .where(
          and(
            eq(somaticPanelVersions.id, input.panelVersionId),
            eq(somaticPanelVersions.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!panel[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Panel version not found.",
        });
      }
      return db
        .select()
        .from(somaticPanelReportableRegions)
        .where(
          and(
            eq(
              somaticPanelReportableRegions.organizationId,
              input.organizationId
            ),
            eq(
              somaticPanelReportableRegions.panelVersionId,
              input.panelVersionId
            )
          )
        )
        .orderBy(
          asc(somaticPanelReportableRegions.regionType),
          asc(somaticPanelReportableRegions.regionKey)
        );
    }),

  createPanelRegion: protectedProcedure
    .input(
      organizationInput
        .extend({
          panelVersionId: z.number().int().positive(),
          regionKey: z.string().trim().min(1).max(240),
          regionType: z.enum([
            "gene",
            "exon",
            "interval",
            "fusion_pair",
            "signature",
          ]),
          findingType: findingType.nullable().optional(),
          gene: z.string().trim().min(1).max(80).nullable().optional(),
          transcript: z.string().trim().min(1).max(120).nullable().optional(),
          chromosome: z.string().trim().min(1).max(16).nullable().optional(),
          start: z.number().int().positive().nullable().optional(),
          end: z.number().int().positive().nullable().optional(),
          target: jsonObject.nullable().optional(),
          minimumDepth: z.number().int().nonnegative().nullable().optional(),
          minimumCoveragePercent: z
            .number()
            .min(0)
            .max(100)
            .nullable()
            .optional(),
          reportable: z.boolean().default(false),
        })
        .superRefine((value, ctx) => {
          if (
            ["exon", "interval"].includes(value.regionType) &&
            (!value.chromosome ||
              value.start == null ||
              value.end == null ||
              value.end < value.start)
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["start"],
              message:
                "Exon and interval regions require chromosome and an ordered coordinate range.",
            });
          }
          if (
            value.regionType === "fusion_pair" &&
            value.findingType !== "FUSION"
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["findingType"],
              message: "Fusion-pair regions must use FUSION finding type.",
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireMutablePanelRegions(
        input.organizationId,
        input.panelVersionId
      );
      const db = await requireDb();
      const rows = await db
        .insert(somaticPanelReportableRegions)
        .values({
          organizationId: input.organizationId,
          panelVersionId: input.panelVersionId,
          regionKey: input.regionKey,
          regionType: input.regionType,
          findingType: input.findingType,
          gene: input.gene,
          transcript: input.transcript,
          chromosome: input.chromosome,
          start: input.start,
          end: input.end,
          target: input.target,
          minimumDepth: input.minimumDepth,
          minimumCoveragePercent:
            input.minimumCoveragePercent == null
              ? null
              : String(input.minimumCoveragePercent),
          reportable: input.reportable,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.panel_region.created",
        entityType: "somatic_panel_reportable_region",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  importPanelRegions: protectedProcedure
    .input(
      organizationInput
        .extend({
          panelVersionId: z.number().int().positive(),
          artifactName: z.string().trim().min(1).max(255),
          artifactHash: sha256,
          regions: z.array(panelRegionImportRecord).min(1).max(10_000),
        })
        .superRefine((value, ctx) => {
          const keys = new Set<string>();
          value.regions.forEach((region, index) => {
            if (keys.has(region.regionKey)) {
              ctx.addIssue({
                code: "custom",
                path: ["regions", index, "regionKey"],
                message: "Region keys must be unique within an artifact.",
              });
            }
            keys.add(region.regionKey);
          });
          if (!value.regions.some(region => region.reportable)) {
            ctx.addIssue({
              code: "custom",
              path: ["regions"],
              message: "At least one reportable region is required.",
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const before = await requireMutablePanelRegions(
        input.organizationId,
        input.panelVersionId
      );
      const db = await requireDb();
      const result = await db.transaction(async tx => {
        await tx
          .delete(somaticPanelReportableRegions)
          .where(
            and(
              eq(
                somaticPanelReportableRegions.organizationId,
                input.organizationId
              ),
              eq(
                somaticPanelReportableRegions.panelVersionId,
                input.panelVersionId
              )
            )
          );
        const regions = await tx
          .insert(somaticPanelReportableRegions)
          .values(
            input.regions.map(region => ({
              organizationId: input.organizationId,
              panelVersionId: input.panelVersionId,
              regionKey: region.regionKey,
              regionType: region.regionType,
              findingType: region.findingType,
              gene: region.gene,
              transcript: region.transcript,
              chromosome: region.chromosome,
              start: region.start,
              end: region.end,
              target: region.target,
              minimumDepth: region.minimumDepth,
              minimumCoveragePercent:
                region.minimumCoveragePercent == null
                  ? null
                  : String(region.minimumCoveragePercent),
              reportable: region.reportable,
            }))
          )
          .returning();
        const panel = await tx
          .update(somaticPanelVersions)
          .set({
            regionArtifactName: input.artifactName,
            regionArtifactHash: input.artifactHash.toLowerCase(),
            regionValidationStatus: "pending",
            regionValidatedBy: null,
            regionValidatedAt: null,
          })
          .where(
            and(
              eq(somaticPanelVersions.id, input.panelVersionId),
              eq(somaticPanelVersions.organizationId, input.organizationId)
            )
          )
          .returning();
        return { panel: panel[0], regions };
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.panel_regions.imported",
        entityType: "somatic_panel_version",
        entityId: input.panelVersionId,
        before,
        after: {
          panel: result.panel,
          regionCount: result.regions.length,
          reportableRegionCount: result.regions.filter(
            region => region.reportable
          ).length,
        },
        req: ctx.req,
      });
      return {
        panel: result.panel,
        regionCount: result.regions.length,
        reportableRegionCount: result.regions.filter(
          region => region.reportable
        ).length,
      };
    }),

  validatePanelRegions: protectedProcedure
    .input(
      organizationInput.extend({
        panelVersionId: z.number().int().positive(),
        artifactHash: sha256,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const db = await requireDb();
      const [panelRows, reportableRows] = await Promise.all([
        db
          .select()
          .from(somaticPanelVersions)
          .where(
            and(
              eq(somaticPanelVersions.id, input.panelVersionId),
              eq(somaticPanelVersions.organizationId, input.organizationId)
            )
          )
          .limit(1),
        db
          .select({ value: count() })
          .from(somaticPanelReportableRegions)
          .where(
            and(
              eq(
                somaticPanelReportableRegions.organizationId,
                input.organizationId
              ),
              eq(
                somaticPanelReportableRegions.panelVersionId,
                input.panelVersionId
              ),
              eq(somaticPanelReportableRegions.reportable, true)
            )
          ),
      ]);
      const before = panelRows[0];
      if (!before) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Panel version not found.",
        });
      }
      if (before.regionValidationStatus !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Panel region validation has already been finalized.",
        });
      }
      if (
        !before.regionArtifactHash ||
        before.regionArtifactHash !== input.artifactHash.toLowerCase()
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The approval hash does not match the imported artifact.",
        });
      }
      if ((reportableRows[0]?.value ?? 0) < 1) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "At least one reportable region is required.",
        });
      }
      const rows = await db
        .update(somaticPanelVersions)
        .set({
          regionValidationStatus: "passed",
          regionValidatedBy: ctx.user.id,
          regionValidatedAt: new Date(),
        })
        .where(
          and(
            eq(somaticPanelVersions.id, input.panelVersionId),
            eq(somaticPanelVersions.organizationId, input.organizationId),
            eq(somaticPanelVersions.regionValidationStatus, "pending")
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.panel_regions.validation_passed",
        entityType: "somatic_panel_version",
        entityId: input.panelVersionId,
        before,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  listCaseCoverage: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const summaries = await db
        .select()
        .from(somaticCaseCoverageSummaries)
        .where(
          and(
            eq(
              somaticCaseCoverageSummaries.organizationId,
              input.organizationId
            ),
            eq(somaticCaseCoverageSummaries.caseId, input.caseId)
          )
        )
        .orderBy(desc(somaticCaseCoverageSummaries.createdAt));
      const summaryIds = summaries.map(summary => summary.id);
      const regionCoverage = summaryIds.length
        ? await db
            .select()
            .from(somaticCaseRegionCoverage)
            .where(
              and(
                eq(
                  somaticCaseRegionCoverage.organizationId,
                  input.organizationId
                ),
                inArray(somaticCaseRegionCoverage.coverageSummaryId, summaryIds)
              )
            )
        : [];
      return { summaries, regionCoverage };
    }),

  createCoverageSummary: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        panelVersionId: z.number().int().positive(),
        qcMetrics: jsonObject,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      const db = await requireDb();
      const regionCountRows = await db
        .select({ value: count() })
        .from(somaticPanelReportableRegions)
        .where(
          and(
            eq(
              somaticPanelReportableRegions.organizationId,
              input.organizationId
            ),
            eq(
              somaticPanelReportableRegions.panelVersionId,
              input.panelVersionId
            ),
            eq(somaticPanelReportableRegions.reportable, true)
          )
        );
      const expectedRegionCount = regionCountRows[0]?.value ?? 0;
      if (expectedRegionCount < 1) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Coverage cannot be recorded until reportable panel regions exist.",
        });
      }
      const rows = await db
        .insert(somaticCaseCoverageSummaries)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          panelVersionId: input.panelVersionId,
          validationStatus: "pending",
          completeRegionCount: 0,
          expectedRegionCount,
          qcMetrics: input.qcMetrics,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.coverage_summary.created",
        entityType: "somatic_case_coverage_summary",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  importCaseCoverage: protectedProcedure
    .input(
      organizationInput
        .extend({
          caseId: z.number().int().positive(),
          panelVersionId: z.number().int().positive(),
          artifactHash: sha256,
          qcMetrics: jsonObject,
          records: z.array(coverageImportRecord).min(1).max(10_000),
        })
        .superRefine((value, ctx) => {
          const keys = new Set<string>();
          value.records.forEach((record, index) => {
            if (keys.has(record.regionKey)) {
              ctx.addIssue({
                code: "custom",
                path: ["records", index, "regionKey"],
                message: "Coverage region keys must be unique.",
              });
            }
            keys.add(record.regionKey);
          });
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      const db = await requireDb();
      const [panelRows, regions, existingRows] = await Promise.all([
        db
          .select()
          .from(somaticPanelVersions)
          .where(
            and(
              eq(somaticPanelVersions.id, input.panelVersionId),
              eq(somaticPanelVersions.organizationId, input.organizationId)
            )
          )
          .limit(1),
        db
          .select()
          .from(somaticPanelReportableRegions)
          .where(
            and(
              eq(
                somaticPanelReportableRegions.organizationId,
                input.organizationId
              ),
              eq(
                somaticPanelReportableRegions.panelVersionId,
                input.panelVersionId
              ),
              eq(somaticPanelReportableRegions.reportable, true)
            )
          ),
        db
          .select()
          .from(somaticCaseCoverageSummaries)
          .where(
            and(
              eq(
                somaticCaseCoverageSummaries.organizationId,
                input.organizationId
              ),
              eq(somaticCaseCoverageSummaries.caseId, input.caseId),
              eq(
                somaticCaseCoverageSummaries.panelVersionId,
                input.panelVersionId
              )
            )
          )
          .limit(1),
      ]);
      const panel = panelRows[0];
      if (!panel || panel.regionValidationStatus !== "passed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Coverage import requires an approved reportable-region artifact.",
        });
      }
      if (!regions.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The panel has no approved reportable regions.",
        });
      }
      const existing = existingRows[0];
      if (existing?.validationStatus === "passed") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Passed coverage is immutable. Create a new case or panel version for a new assay result.",
        });
      }
      const regionByKey = new Map(
        regions.map(region => [region.regionKey, region])
      );
      const unknownKeys = input.records
        .map(record => record.regionKey)
        .filter(regionKey => !regionByKey.has(regionKey));
      if (unknownKeys.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Coverage artifact contains unknown region keys: ${unknownKeys.join(", ")}`,
        });
      }
      const measurements = input.records.map(record => {
        const region = regionByKey.get(record.regionKey)!;
        const decision = evaluateRegionCoverageMeasurement(
          {
            minimumDepth: region.minimumDepth,
            minimumCoveragePercent:
              region.minimumCoveragePercent == null
                ? null
                : Number(region.minimumCoveragePercent),
          },
          {
            meanDepth: record.meanDepth,
            coveredPercent: record.coveredPercent,
          }
        );
        return { record, region, decision };
      });
      const result = await db.transaction(async tx => {
        let summary;
        if (existing) {
          await tx
            .delete(somaticCaseRegionCoverage)
            .where(
              and(
                eq(
                  somaticCaseRegionCoverage.organizationId,
                  input.organizationId
                ),
                eq(somaticCaseRegionCoverage.coverageSummaryId, existing.id)
              )
            );
          const rows = await tx
            .update(somaticCaseCoverageSummaries)
            .set({
              validationStatus: "pending",
              completeRegionCount: 0,
              expectedRegionCount: regions.length,
              qcMetrics: input.qcMetrics,
              sourceArtifactHash: input.artifactHash.toLowerCase(),
              validationHash: null,
              validatedBy: null,
              validatedAt: null,
            })
            .where(
              and(
                eq(somaticCaseCoverageSummaries.id, existing.id),
                eq(
                  somaticCaseCoverageSummaries.organizationId,
                  input.organizationId
                )
              )
            )
            .returning();
          summary = rows[0];
        } else {
          const rows = await tx
            .insert(somaticCaseCoverageSummaries)
            .values({
              organizationId: input.organizationId,
              caseId: input.caseId,
              panelVersionId: input.panelVersionId,
              validationStatus: "pending",
              completeRegionCount: 0,
              expectedRegionCount: regions.length,
              qcMetrics: input.qcMetrics,
              sourceArtifactHash: input.artifactHash.toLowerCase(),
            })
            .returning();
          summary = rows[0];
        }
        const coverageRows = await tx
          .insert(somaticCaseRegionCoverage)
          .values(
            measurements.map(({ record, region, decision }) => ({
              organizationId: input.organizationId,
              coverageSummaryId: summary.id,
              panelRegionId: region.id,
              meanDepth:
                record.meanDepth == null ? null : String(record.meanDepth),
              coveredPercent:
                record.coveredPercent == null
                  ? null
                  : String(record.coveredPercent),
              qcPassed: decision.passed,
              qcReasons: decision.reasons,
            }))
          )
          .returning();
        return { summary, coverageRows };
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: existing
          ? "somatic.coverage_artifact.replaced"
          : "somatic.coverage_artifact.imported",
        entityType: "somatic_case_coverage_summary",
        entityId: result.summary.id,
        before: existing ?? null,
        after: {
          ...result.summary,
          importedRegionCount: result.coverageRows.length,
          failedRegionCount: result.coverageRows.filter(row => !row.qcPassed)
            .length,
        },
        req: ctx.req,
      });
      return {
        summary: result.summary,
        importedRegionCount: result.coverageRows.length,
        failedRegionCount: result.coverageRows.filter(row => !row.qcPassed)
          .length,
      };
    }),

  recordRegionCoverage: protectedProcedure
    .input(
      organizationInput.extend({
        coverageSummaryId: z.number().int().positive(),
        panelRegionId: z.number().int().positive(),
        meanDepth: z.number().nonnegative().nullable(),
        coveredPercent: z.number().min(0).max(100).nullable(),
        qcPassed: z.boolean(),
        qcReasons: z.array(z.string().trim().min(1).max(500)).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const [summaryRows, regionRows] = await Promise.all([
        db
          .select()
          .from(somaticCaseCoverageSummaries)
          .where(
            and(
              eq(somaticCaseCoverageSummaries.id, input.coverageSummaryId),
              eq(
                somaticCaseCoverageSummaries.organizationId,
                input.organizationId
              )
            )
          )
          .limit(1),
        db
          .select()
          .from(somaticPanelReportableRegions)
          .where(
            and(
              eq(somaticPanelReportableRegions.id, input.panelRegionId),
              eq(
                somaticPanelReportableRegions.organizationId,
                input.organizationId
              )
            )
          )
          .limit(1),
      ]);
      const summary = summaryRows[0];
      const region = regionRows[0];
      if (
        !summary ||
        !region ||
        region.panelVersionId !== summary.panelVersionId
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Matching coverage summary and panel region not found.",
        });
      }
      if (summary.validationStatus === "passed") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Passed coverage validation is immutable.",
        });
      }
      const coverageSummaryReset = summary.validationStatus === "failed";
      if (coverageSummaryReset) {
        await db
          .update(somaticCaseCoverageSummaries)
          .set({
            validationStatus: "pending",
            validationHash: null,
            validatedBy: null,
            validatedAt: null,
          })
          .where(
            and(
              eq(somaticCaseCoverageSummaries.id, input.coverageSummaryId),
              eq(
                somaticCaseCoverageSummaries.organizationId,
                input.organizationId
              ),
              eq(somaticCaseCoverageSummaries.validationStatus, "failed")
            )
          );
      }
      const beforeRows = await db
        .select()
        .from(somaticCaseRegionCoverage)
        .where(
          and(
            eq(somaticCaseRegionCoverage.organizationId, input.organizationId),
            eq(
              somaticCaseRegionCoverage.coverageSummaryId,
              input.coverageSummaryId
            ),
            eq(somaticCaseRegionCoverage.panelRegionId, input.panelRegionId)
          )
        )
        .limit(1);
      const values = {
        meanDepth: input.meanDepth == null ? null : String(input.meanDepth),
        coveredPercent:
          input.coveredPercent == null ? null : String(input.coveredPercent),
        qcPassed: input.qcPassed,
        qcReasons: input.qcReasons,
      };
      const rows = beforeRows[0]
        ? await db
            .update(somaticCaseRegionCoverage)
            .set(values)
            .where(
              and(
                eq(somaticCaseRegionCoverage.id, beforeRows[0].id),
                eq(
                  somaticCaseRegionCoverage.organizationId,
                  input.organizationId
                )
              )
            )
            .returning()
        : await db
            .insert(somaticCaseRegionCoverage)
            .values({
              organizationId: input.organizationId,
              coverageSummaryId: input.coverageSummaryId,
              panelRegionId: input.panelRegionId,
              ...values,
            })
            .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: beforeRows[0]
          ? "somatic.region_coverage.updated"
          : "somatic.region_coverage.created",
        entityType: "somatic_case_region_coverage",
        entityId: rows[0].id,
        before: beforeRows[0] ?? null,
        after: { ...rows[0], coverageSummaryReset },
        req: ctx.req,
      });
      return rows[0];
    }),

  validateCoverageSummary: protectedProcedure
    .input(
      organizationInput.extend({
        coverageSummaryId: z.number().int().positive(),
        validationArtifactHash: sha256,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const db = await requireDb();
      const summaryRows = await db
        .select()
        .from(somaticCaseCoverageSummaries)
        .where(
          and(
            eq(somaticCaseCoverageSummaries.id, input.coverageSummaryId),
            eq(
              somaticCaseCoverageSummaries.organizationId,
              input.organizationId
            )
          )
        )
        .limit(1);
      const summary = summaryRows[0];
      if (!summary) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Coverage summary not found.",
        });
      }
      if (summary.validationStatus !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Coverage validation has already been finalized.",
        });
      }
      if (
        summary.sourceArtifactHash &&
        summary.sourceArtifactHash !==
          input.validationArtifactHash.toLowerCase()
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "The approval hash does not match the imported coverage artifact.",
        });
      }
      const [regions, coverageRows] = await Promise.all([
        db
          .select({ id: somaticPanelReportableRegions.id })
          .from(somaticPanelReportableRegions)
          .where(
            and(
              eq(
                somaticPanelReportableRegions.organizationId,
                input.organizationId
              ),
              eq(
                somaticPanelReportableRegions.panelVersionId,
                summary.panelVersionId
              ),
              eq(somaticPanelReportableRegions.reportable, true)
            )
          ),
        db
          .select()
          .from(somaticCaseRegionCoverage)
          .where(
            and(
              eq(
                somaticCaseRegionCoverage.organizationId,
                input.organizationId
              ),
              eq(
                somaticCaseRegionCoverage.coverageSummaryId,
                input.coverageSummaryId
              )
            )
          ),
      ]);
      if (!regions.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The panel has no reportable regions to validate.",
        });
      }
      const validation = evaluateRegionCoverageValidation(
        regions.map(region => region.id),
        coverageRows
      );
      const validatedAt = new Date();
      const rows = await db
        .update(somaticCaseCoverageSummaries)
        .set({
          validationStatus: validation.passed ? "passed" : "failed",
          expectedRegionCount: regions.length,
          completeRegionCount: validation.completeRegionCount,
          validationHash: input.validationArtifactHash.toLowerCase(),
          validatedBy: ctx.user.id,
          validatedAt,
        })
        .where(
          and(
            eq(somaticCaseCoverageSummaries.id, input.coverageSummaryId),
            eq(
              somaticCaseCoverageSummaries.organizationId,
              input.organizationId
            ),
            eq(somaticCaseCoverageSummaries.validationStatus, "pending")
          )
        )
        .returning();
      const validationResult = {
        ...validation,
        validationArtifactHash: input.validationArtifactHash.toLowerCase(),
      };
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: validation.passed
          ? "somatic.coverage_summary.validation_passed"
          : "somatic.coverage_summary.validation_failed",
        entityType: "somatic_case_coverage_summary",
        entityId: input.coverageSummaryId,
        before: summary,
        after: { ...rows[0], validation: validationResult },
        req: ctx.req,
      });
      return { summary: rows[0], validation: validationResult };
    }),

  stageAssayArtifact: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        panelVersionId: z.number().int().positive(),
        fileName: z.string().trim().min(1).max(255),
        artifactText: z.string().min(1).max(20_000_000),
        artifactHash: sha256,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      let records;
      try {
        records = parseAssayArtifact(input.artifactText);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "Assay artifact is invalid.",
        });
      }
      const file = await persistSomaticArtifact({
        organizationId: input.organizationId,
        caseId: input.caseId,
        userId: ctx.user.id,
        fileName: input.fileName,
        artifactText: input.artifactText,
        artifactHash: input.artifactHash,
        kind: "assay_result",
        mimeType: input.fileName.toLowerCase().endsWith(".json")
          ? "application/json"
          : "text/tab-separated-values",
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.assay_artifact.staged",
        entityType: "case_file",
        entityId: file.id,
        after: {
          caseId: input.caseId,
          panelVersionId: input.panelVersionId,
          artifactHash: file.sha256,
          recordCount: records.length,
        },
        req: ctx.req,
      });
      return { file, records };
    }),

  importAssayFindings: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        panelVersionId: z.number().int().positive(),
        artifactFileId: z.number().int().positive(),
        records: z.array(assayImportRecord).min(1).max(1_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      const db = await requireDb();
      const fileRows = await db
        .select({ id: caseFiles.id, sha256: caseFiles.sha256 })
        .from(caseFiles)
        .where(
          and(
            eq(caseFiles.id, input.artifactFileId),
            eq(caseFiles.organizationId, input.organizationId),
            eq(caseFiles.caseId, input.caseId),
            eq(caseFiles.kind, "assay_result"),
            eq(caseFiles.status, "verified")
          )
        )
        .limit(1);
      if (!fileRows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Verified assay artifact not found.",
        });
      }
      const coverageIds = Array.from(
        new Set(
          input.records
            .map(record => record.coverageSummaryId)
            .filter((id): id is number => id != null)
        )
      );
      if (coverageIds.length) {
        const coverageRows = await db
          .select({ id: somaticCaseCoverageSummaries.id })
          .from(somaticCaseCoverageSummaries)
          .where(
            and(
              eq(
                somaticCaseCoverageSummaries.organizationId,
                input.organizationId
              ),
              eq(somaticCaseCoverageSummaries.caseId, input.caseId),
              eq(
                somaticCaseCoverageSummaries.panelVersionId,
                input.panelVersionId
              ),
              inArray(somaticCaseCoverageSummaries.id, coverageIds)
            )
          );
        if (coverageRows.length !== coverageIds.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "One or more coverageSummaryId values do not belong to this case and panel.",
          });
        }
      }
      const rows = await db
        .insert(somaticAssayFindings)
        .values(
          input.records.map(record => ({
            organizationId: input.organizationId,
            caseId: input.caseId,
            panelVersionId: input.panelVersionId,
            coverageSummaryId: record.coverageSummaryId,
            findingType: record.findingType,
            status: record.status,
            result: record.result,
            reportable: false,
            reportabilityReasons:
              record.status === "not_detected" ||
              record.status === "not_tested"
                ? ["not_reviewed", "negative_reporting_policy_disabled"]
                : ["not_reviewed"],
            sourceRunId: record.sourceRunId,
            sourceArtifactFileId: input.artifactFileId,
            sourceArtifactHash: fileRows[0].sha256,
          }))
        )
        .returning({ id: somaticAssayFindings.id });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.assay_findings.bulk_imported",
        entityType: "case_file",
        entityId: input.artifactFileId,
        after: {
          importedRecordCount: rows.length,
          findingIds: rows.map(row => row.id),
          artifactHash: fileRows[0].sha256,
        },
        req: ctx.req,
      });
      return { importedRecordCount: rows.length };
    }),

  previewAssayArtifactImpact: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        targetArtifactFileId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const impact = await buildAssayArtifactImpact(
        input.organizationId,
        input.caseId,
        input.targetArtifactFileId
      );
      return {
        targetArtifact: impact.artifact,
        targetFindings: impact.targetFindings,
        supersededFindings: impact.supersededFindings,
        changeHash: impact.changeHash,
      };
    }),

  createAssayArtifactImpactTask: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        targetArtifactFileId: z.number().int().positive(),
        expectedChangeHash: sha256,
        changeControlId: z.string().trim().min(3).max(160),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const impact = await buildAssayArtifactImpact(
        input.organizationId,
        input.caseId,
        input.targetArtifactFileId
      );
      if (impact.changeHash !== input.expectedChangeHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Assay findings changed after preview; review them again.",
        });
      }
      if (!impact.supersededFindings.length) {
        return { createdTaskCount: 0, supersededFindingCount: 0 };
      }
      const db = await requireDb();
      const releases = await db
        .select()
        .from(somaticKnowledgeReleases)
        .where(
          and(
            eq(somaticKnowledgeReleases.organizationId, input.organizationId),
            eq(somaticKnowledgeReleases.status, "active"),
            eq(somaticKnowledgeReleases.validationStatus, "passed")
          )
        )
        .orderBy(desc(somaticKnowledgeReleases.activatedAt))
        .limit(1);
      const release = releases[0];
      if (!release) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "An active validated knowledge release is required for assay reinterpretation.",
        });
      }
      const created = await db
        .insert(somaticReinterpretationTasks)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          releaseId: release.id,
          findingId: impact.supersededFindings[0].id,
          changeKind: "assay_artifact",
          changeKey: `assay:${input.targetArtifactFileId}`,
          reason: `A new assay artifact may supersede ${impact.supersededFindings.length} reviewed reportable finding(s).`,
          impact: {
            kind: "assay_artifact",
            changeControlId: input.changeControlId,
            changeHash: impact.changeHash,
            targetArtifactFileId: input.targetArtifactFileId,
            targetArtifactHash: impact.artifact.sha256,
            targetFindingIds: impact.targetFindings.map(finding => finding.id),
            supersededFindingIds: impact.supersededFindings.map(
              finding => finding.id
            ),
          },
          previousReleaseVersion: release.version,
          targetReleaseVersion: release.version,
          createdBy: ctx.user.id,
        })
        .onConflictDoNothing()
        .returning({ id: somaticReinterpretationTasks.id });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.assay_impact.task_created",
        entityType: "case_file",
        entityId: input.targetArtifactFileId,
        after: {
          caseId: input.caseId,
          changeControlId: input.changeControlId,
          changeHash: impact.changeHash,
          supersededFindingCount: impact.supersededFindings.length,
          createdTaskCount: created.length,
        },
        req: ctx.req,
      });
      return {
        createdTaskCount: created.length,
        supersededFindingCount: impact.supersededFindings.length,
      };
    }),

  listAssayFindings: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      return db
        .select()
        .from(somaticAssayFindings)
        .where(
          and(
            eq(somaticAssayFindings.organizationId, input.organizationId),
            eq(somaticAssayFindings.caseId, input.caseId)
          )
        )
        .orderBy(
          asc(somaticAssayFindings.findingType),
          desc(somaticAssayFindings.createdAt)
        );
    }),

  createAssayFinding: protectedProcedure
    .input(
      organizationInput
        .extend({
          caseId: z.number().int().positive(),
          panelVersionId: z.number().int().positive(),
          coverageSummaryId: z.number().int().positive().nullable().optional(),
          findingType,
          status: findingStatus,
          result: findingResult.nullable(),
          sourceRunId: z.string().trim().min(1).max(160).nullable().optional(),
        })
        .superRefine((value, ctx) => {
          if (value.result && value.result.type !== value.findingType) {
            ctx.addIssue({
              code: "custom",
              path: ["result", "type"],
              message: "Finding result type must match findingType.",
            });
          }
          if (value.status === "detected" && !value.result) {
            ctx.addIssue({
              code: "custom",
              path: ["result"],
              message: "Detected findings require a typed result.",
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireSomaticCasePanel(
        input.organizationId,
        input.caseId,
        input.panelVersionId
      );
      const db = await requireDb();
      if (input.coverageSummaryId) {
        const coverage = await db
          .select({ id: somaticCaseCoverageSummaries.id })
          .from(somaticCaseCoverageSummaries)
          .where(
            and(
              eq(somaticCaseCoverageSummaries.id, input.coverageSummaryId),
              eq(
                somaticCaseCoverageSummaries.organizationId,
                input.organizationId
              ),
              eq(somaticCaseCoverageSummaries.caseId, input.caseId),
              eq(
                somaticCaseCoverageSummaries.panelVersionId,
                input.panelVersionId
              )
            )
          )
          .limit(1);
        if (!coverage[0]) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Matching case coverage summary not found.",
          });
        }
      }
      const negative =
        input.status === "not_detected" || input.status === "not_tested";
      const rows = await db
        .insert(somaticAssayFindings)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          panelVersionId: input.panelVersionId,
          coverageSummaryId: input.coverageSummaryId,
          findingType: input.findingType,
          status: input.status,
          result: input.result,
          reportable: false,
          reportabilityReasons: negative
            ? ["not_reviewed", "negative_reporting_policy_disabled"]
            : ["not_reviewed"],
          sourceRunId: input.sourceRunId,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.assay_finding.created",
        entityType: "somatic_assay_finding",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  reviewAssayFinding: protectedProcedure
    .input(
      organizationInput.extend({
        findingId: z.number().int().positive(),
        reportable: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:approve"
      );
      const db = await requireDb();
      const findingRows = await db
        .select()
        .from(somaticAssayFindings)
        .where(
          and(
            eq(somaticAssayFindings.id, input.findingId),
            eq(somaticAssayFindings.organizationId, input.organizationId)
          )
        )
        .limit(1);
      const finding = findingRows[0];
      if (!finding) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assay finding not found.",
        });
      }
      const [policyRows, panelRows, panelRegionCountRows, coverageRows] =
        await Promise.all([
          db
            .select()
            .from(somaticOrganizationPolicyProfiles)
            .where(
              and(
                eq(
                  somaticOrganizationPolicyProfiles.organizationId,
                  input.organizationId
                ),
                eq(somaticOrganizationPolicyProfiles.status, "active")
              )
            )
            .limit(1),
          db
            .select({
              regionValidationStatus:
                somaticPanelVersions.regionValidationStatus,
              regionArtifactHash: somaticPanelVersions.regionArtifactHash,
            })
            .from(somaticPanelVersions)
            .where(
              and(
                eq(somaticPanelVersions.id, finding.panelVersionId),
                eq(somaticPanelVersions.organizationId, input.organizationId)
              )
            )
            .limit(1),
          db
            .select({ value: count() })
            .from(somaticPanelReportableRegions)
            .where(
              and(
                eq(
                  somaticPanelReportableRegions.organizationId,
                  input.organizationId
                ),
                eq(
                  somaticPanelReportableRegions.panelVersionId,
                  finding.panelVersionId
                ),
                eq(somaticPanelReportableRegions.reportable, true)
              )
            ),
          finding.coverageSummaryId
            ? db
                .select()
                .from(somaticCaseCoverageSummaries)
                .where(
                  and(
                    eq(
                      somaticCaseCoverageSummaries.id,
                      finding.coverageSummaryId
                    ),
                    eq(
                      somaticCaseCoverageSummaries.organizationId,
                      input.organizationId
                    )
                  )
                )
                .limit(1)
            : Promise.resolve([]),
        ]);
      const policy = policyRows[0];
      const policyValidation = policy
        ? validateNegativeReportingPolicy(
            policy.allowNegativeReporting,
            policy.policy
          )
        : { valid: true, validationArtifactHash: null };
      const coverage = coverageRows[0];
      const failedCoverageRows = coverage
        ? await db
            .select({ id: somaticCaseRegionCoverage.id })
            .from(somaticCaseRegionCoverage)
            .where(
              and(
                eq(
                  somaticCaseRegionCoverage.organizationId,
                  input.organizationId
                ),
                eq(somaticCaseRegionCoverage.coverageSummaryId, coverage.id),
                eq(somaticCaseRegionCoverage.qcPassed, false)
              )
            )
        : [];
      const decision = evaluateFindingReportability({
        status: finding.status,
        policyAllowsNegativeReporting:
          (policy?.allowNegativeReporting ?? false) && policyValidation.valid,
        findingCaseId: finding.caseId,
        findingPanelVersionId: finding.panelVersionId,
        panelRegionValidationStatus:
          panelRows[0]?.regionValidationStatus ?? null,
        panelRegionArtifactHash: panelRows[0]?.regionArtifactHash ?? null,
        coverageCaseId: coverage?.caseId,
        coveragePanelVersionId: coverage?.panelVersionId,
        panelReportableRegionCount: panelRegionCountRows[0]?.value ?? 0,
        coverageValidationStatus: coverage?.validationStatus,
        expectedRegionCount: coverage?.expectedRegionCount,
        completeRegionCount: coverage?.completeRegionCount,
        failedRegionCount: failedCoverageRows.length,
        validationHash: coverage?.validationHash,
      });
      if (input.reportable && !decision.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Reportability gates failed: ${decision.reasons.join(", ")}`,
        });
      }
      const reportabilityReasons = input.reportable
        ? []
        : Array.from(
            new Set(["reviewer_marked_not_reportable", ...decision.reasons])
          );
      const rows = await db
        .update(somaticAssayFindings)
        .set({
          reportable: input.reportable,
          reportabilityReasons,
          reviewedBy: ctx.user.id,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(somaticAssayFindings.id, input.findingId),
            eq(somaticAssayFindings.organizationId, input.organizationId)
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: input.reportable
          ? "somatic.assay_finding.marked_reportable"
          : "somatic.assay_finding.marked_not_reportable",
        entityType: "somatic_assay_finding",
        entityId: input.findingId,
        before: finding,
        after: { ...rows[0], gateDecision: decision },
        req: ctx.req,
      });
      return { finding: rows[0], gateDecision: decision };
    }),

  listReinterpretationTasks: protectedProcedure
    .input(
      organizationInput.extend({
        status: z
          .enum(["open", "in_review", "completed", "dismissed"])
          .optional(),
        caseId: z.number().int().positive().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const filters = [
        eq(somaticReinterpretationTasks.organizationId, input.organizationId),
        ...(input.status
          ? [eq(somaticReinterpretationTasks.status, input.status)]
          : []),
        ...(input.caseId
          ? [eq(somaticReinterpretationTasks.caseId, input.caseId)]
          : []),
      ];
      const tasks = await db
        .select()
        .from(somaticReinterpretationTasks)
        .where(and(...filters))
        .orderBy(
          asc(somaticReinterpretationTasks.status),
          desc(somaticReinterpretationTasks.createdAt)
        );
      const runIds = tasks.flatMap(task =>
        task.interpretationRunId ? [task.interpretationRunId] : []
      );
      const [runs, unresolvedAssertions] = runIds.length
        ? await Promise.all([
            db
              .select({
                id: somaticInterpretationRuns.id,
                status: somaticInterpretationRuns.status,
                attemptCount: somaticInterpretationRuns.attemptCount,
                maxAttempts: somaticInterpretationRuns.maxAttempts,
                completedAt: somaticInterpretationRuns.completedAt,
              })
              .from(somaticInterpretationRuns)
              .where(
                and(
                  eq(
                    somaticInterpretationRuns.organizationId,
                    input.organizationId
                  ),
                  inArray(somaticInterpretationRuns.id, runIds)
                )
              ),
            db
              .select({
                id: somaticClinicalAssertions.id,
                runId: somaticClinicalAssertions.runId,
              })
              .from(somaticClinicalAssertions)
              .where(
                and(
                  eq(
                    somaticClinicalAssertions.organizationId,
                    input.organizationId
                  ),
                  inArray(somaticClinicalAssertions.runId, runIds),
                  inArray(somaticClinicalAssertions.status, [
                    "proposed",
                    "in_review",
                  ])
                )
              ),
          ])
        : [[], []];
      const runById = new Map(runs.map(run => [run.id, run]));
      const unresolvedByRun = new Map<number, number>();
      for (const assertion of unresolvedAssertions) {
        unresolvedByRun.set(
          assertion.runId,
          (unresolvedByRun.get(assertion.runId) ?? 0) + 1
        );
      }
      return tasks.map(task => {
        const run = task.interpretationRunId
          ? (runById.get(task.interpretationRunId) ?? null)
          : null;
        return {
          ...task,
          interpretationRun: run
            ? {
                ...run,
                unresolvedAssertions: unresolvedByRun.get(run.id) ?? 0,
              }
            : null,
        };
      });
    }),

  enqueueReinterpretationTasks: protectedProcedure
    .input(
      organizationInput.extend({
        taskIds: z.array(z.number().int().positive()).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const requestedTaskIds = Array.from(new Set(input.taskIds));
      const db = await requireDb();
      const tasks = await db
        .select()
        .from(somaticReinterpretationTasks)
        .where(
          and(
            eq(
              somaticReinterpretationTasks.organizationId,
              input.organizationId
            ),
            inArray(somaticReinterpretationTasks.id, requestedTaskIds)
          )
        );
      if (tasks.length !== requestedTaskIds.length) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more reinterpretation tasks were not found.",
        });
      }
      const releaseIds = Array.from(new Set(tasks.map(task => task.releaseId)));
      const releases = await db
        .select()
        .from(somaticKnowledgeReleases)
        .where(
          and(
            eq(somaticKnowledgeReleases.organizationId, input.organizationId),
            inArray(somaticKnowledgeReleases.id, releaseIds)
          )
        );
      const releaseById = new Map(
        releases.map(release => [release.id, release])
      );
      const results: Array<{
        taskId: number;
        caseId: number;
        runId: number;
        deduplicated: boolean;
      }> = [];
      const skipped: Array<{ taskId: number; reason: string }> = [];
      for (const task of tasks) {
        if (task.status !== "open" && task.status !== "in_review") {
          skipped.push({ taskId: task.id, reason: "task_is_terminal" });
          continue;
        }
        const release = releaseById.get(task.releaseId);
        if (
          !release ||
          release.status !== "active" ||
          release.validationStatus !== "passed" ||
          release.version !== task.targetReleaseVersion
        ) {
          skipped.push({
            taskId: task.id,
            reason: "target_release_not_active",
          });
          continue;
        }
        if (task.interpretationRunId) {
          results.push({
            taskId: task.id,
            caseId: task.caseId,
            runId: task.interpretationRunId,
            deduplicated: true,
          });
          continue;
        }
        try {
          const queued = await enqueueSomaticInterpretationRun({
            organizationId: input.organizationId,
            caseId: task.caseId,
            requestedBy: ctx.user.id,
            req: ctx.req,
            trigger: "reinterpretation",
            reinterpretationTaskId: task.id,
          });
          const enqueuedAt = new Date();
          await db
            .update(somaticReinterpretationTasks)
            .set({
              status: "in_review",
              interpretationRunId: queued.runId,
              enqueuedBy: ctx.user.id,
              enqueuedAt,
            })
            .where(
              and(
                eq(somaticReinterpretationTasks.id, task.id),
                eq(
                  somaticReinterpretationTasks.organizationId,
                  input.organizationId
                ),
                inArray(somaticReinterpretationTasks.status, [
                  "open",
                  "in_review",
                ])
              )
            );
          await writeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: ctx.user.id,
            action: "somatic.reinterpretation_task.run_enqueued",
            entityType: "somatic_reinterpretation_task",
            entityId: task.id,
            before: task,
            after: {
              status: "in_review",
              interpretationRunId: queued.runId,
              enqueuedAt,
              deduplicated: queued.deduplicated,
            },
            req: ctx.req,
          });
          results.push({
            taskId: task.id,
            caseId: task.caseId,
            runId: queued.runId,
            deduplicated: queued.deduplicated,
          });
        } catch (error) {
          skipped.push({
            taskId: task.id,
            reason: error instanceof Error ? error.message : "enqueue_failed",
          });
        }
      }
      return {
        queued: results.filter(result => !result.deduplicated).length,
        deduplicated: results.filter(result => result.deduplicated).length,
        results,
        skipped,
      };
    }),

  createReinterpretationTask: protectedProcedure
    .input(
      organizationInput.extend({
        caseId: z.number().int().positive(),
        releaseId: z.number().int().positive(),
        findingId: z.number().int().positive().nullable().optional(),
        reason: z.string().trim().min(10).max(8000),
        impact: jsonObject,
        previousReleaseVersion: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .nullable()
          .optional(),
        assignedTo: z.number().int().positive().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireOrganizationAssignee(input.organizationId, input.assignedTo);
      const db = await requireDb();
      const [caseRows, releaseRows, findingRows] = await Promise.all([
        db
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.id, input.caseId),
              eq(cases.organizationId, input.organizationId),
              eq(cases.purpose, "somatic")
            )
          )
          .limit(1),
        db
          .select()
          .from(somaticKnowledgeReleases)
          .where(
            and(
              eq(somaticKnowledgeReleases.id, input.releaseId),
              eq(somaticKnowledgeReleases.organizationId, input.organizationId)
            )
          )
          .limit(1),
        input.findingId
          ? db
              .select({ id: somaticAssayFindings.id })
              .from(somaticAssayFindings)
              .where(
                and(
                  eq(somaticAssayFindings.id, input.findingId),
                  eq(somaticAssayFindings.organizationId, input.organizationId),
                  eq(somaticAssayFindings.caseId, input.caseId)
                )
              )
              .limit(1)
          : Promise.resolve([{ id: null }]),
      ]);
      if (!caseRows[0] || !releaseRows[0] || !findingRows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Somatic case, release, or linked finding not found.",
        });
      }
      const rows = await db
        .insert(somaticReinterpretationTasks)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          releaseId: input.releaseId,
          findingId: input.findingId,
          reason: input.reason,
          impact: input.impact,
          previousReleaseVersion: input.previousReleaseVersion,
          targetReleaseVersion: releaseRows[0].version,
          assignedTo: input.assignedTo,
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.reinterpretation_task.created",
        entityType: "somatic_reinterpretation_task",
        entityId: rows[0].id,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),

  updateReinterpretationTask: protectedProcedure
    .input(
      organizationInput.extend({
        taskId: z.number().int().positive(),
        status: z.enum(["open", "in_review", "completed", "dismissed"]),
        assignedTo: z.number().int().positive().nullable().optional(),
        reason: z.string().trim().min(10).max(8000).optional(),
        impact: jsonObject.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const approvalDecision =
        input.status === "completed" || input.status === "dismissed";
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        approvalDecision ? "interpretation:approve" : "interpretation:edit"
      );
      await requireOrganizationAssignee(input.organizationId, input.assignedTo);
      const db = await requireDb();
      const beforeRows = await db
        .select()
        .from(somaticReinterpretationTasks)
        .where(
          and(
            eq(somaticReinterpretationTasks.id, input.taskId),
            eq(
              somaticReinterpretationTasks.organizationId,
              input.organizationId
            )
          )
        )
        .limit(1);
      const before = beforeRows[0];
      if (!before) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Reinterpretation task not found.",
        });
      }
      if (before.status === "completed" || before.status === "dismissed") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Completed or dismissed tasks are immutable.",
        });
      }
      if (input.status === "completed" && before.interpretationRunId) {
        const [runRows, unresolvedAssertions] = await Promise.all([
          db
            .select({ status: somaticInterpretationRuns.status })
            .from(somaticInterpretationRuns)
            .where(
              and(
                eq(somaticInterpretationRuns.id, before.interpretationRunId),
                eq(
                  somaticInterpretationRuns.organizationId,
                  input.organizationId
                )
              )
            )
            .limit(1),
          db
            .select({ id: somaticClinicalAssertions.id })
            .from(somaticClinicalAssertions)
            .where(
              and(
                eq(
                  somaticClinicalAssertions.organizationId,
                  input.organizationId
                ),
                eq(somaticClinicalAssertions.runId, before.interpretationRunId),
                inArray(somaticClinicalAssertions.status, [
                  "proposed",
                  "in_review",
                ])
              )
            )
            .limit(10),
        ]);
        if (runRows[0]?.status !== "ready_for_review") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "A linked reinterpretation run must be ready for review before the task can be completed.",
          });
        }
        if (unresolvedAssertions.length) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Review all linked run assertions before completing the task: ${unresolvedAssertions.map(assertion => assertion.id).join(", ")}.`,
          });
        }
      }
      const terminal =
        input.status === "completed" || input.status === "dismissed";
      const rows = await db
        .update(somaticReinterpretationTasks)
        .set({
          status: input.status,
          assignedTo:
            input.assignedTo === undefined
              ? before.assignedTo
              : input.assignedTo,
          reason: input.reason ?? before.reason,
          impact: input.impact ?? before.impact,
          completedBy: terminal ? ctx.user.id : null,
          completedAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(somaticReinterpretationTasks.id, input.taskId),
            eq(
              somaticReinterpretationTasks.organizationId,
              input.organizationId
            )
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: terminal
          ? `somatic.reinterpretation_task.${input.status}`
          : "somatic.reinterpretation_task.updated",
        entityType: "somatic_reinterpretation_task",
        entityId: input.taskId,
        before,
        after: rows[0],
        req: ctx.req,
      });
      return rows[0];
    }),
});

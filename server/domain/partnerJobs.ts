import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  analysisJobs,
  caseFiles,
  cases,
  curationRuns,
  organizationMembers,
  organizations,
  projects,
  samples,
  users,
  variants,
} from "../../drizzle/schema";
import { curationDocumentSchema } from "@shared/curation/document";
import {
  partnerInterpretationJobSchema,
  partnerVariantSummarySchema,
  type PartnerInterpretationJob,
  type PartnerInterpretationResult,
  type PartnerVariantSummary,
} from "@shared/partnerInterpretation";
import { alignClinvarClaim } from "./clinvarClaim";
import { ACTIVE_CURATION_STATUSES } from "./curationQueue";
import {
  PARTNER_ORG_SLUG,
  PARTNER_USER_OPEN_ID,
  partnerJobLookupId,
  partnerJobManifest,
  partnerJobStorageKey,
  partnerStatusFromParts,
  partnerVcfUploadPath,
  readPartnerManifest,
  vcfFileName,
  type PartnerJobManifest,
} from "./partnerJobState";
import { requireDb } from "./tenant";
import { ingestVcfForJob } from "../routers/cases";
import { storageGetText, storagePut } from "../storage";

export class PartnerJobError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type StoredJob = typeof analysisJobs.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  return `${message}\n${cause}`.includes("23505");
}

async function ensurePartnerTenant() {
  const db = await requireDb();
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.openId, PARTNER_USER_OPEN_ID))
    .limit(1);
  let userId = existingUser[0]?.id;
  if (!userId) {
    const inserted = await db
      .insert(users)
      .values({
        openId: PARTNER_USER_OPEN_ID,
        name: "gx-portal partner",
        email: "partner-api@genolyx.local",
        loginMethod: "partner",
        role: "user",
      })
      .returning({ id: users.id });
    userId = inserted[0]?.id;
  }
  if (!userId)
    throw new PartnerJobError(
      500,
      "partner_tenant_missing",
      "Partner user was not stored"
    );

  const existingOrg = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, PARTNER_ORG_SLUG))
    .limit(1);
  let organizationId = existingOrg[0]?.id;
  if (!organizationId) {
    const inserted = await db
      .insert(organizations)
      .values({
        name: "gx-portal",
        slug: PARTNER_ORG_SLUG,
        createdBy: userId,
      })
      .returning({ id: organizations.id });
    organizationId = inserted[0]?.id;
  }
  if (!organizationId) {
    throw new PartnerJobError(
      500,
      "partner_tenant_missing",
      "Partner organization was not stored"
    );
  }

  await db
    .insert(organizationMembers)
    .values({
      organizationId,
      userId,
      role: "administrator",
      status: "active",
    })
    .onConflictDoNothing();

  const existingProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.code, "portal")
      )
    )
    .limit(1);
  let projectId = existingProject[0]?.id;
  if (!projectId) {
    const inserted = await db
      .insert(projects)
      .values({
        organizationId,
        name: "Portal orders",
        code: "portal",
        createdBy: userId,
      })
      .returning({ id: projects.id });
    projectId = inserted[0]?.id;
  }
  if (!projectId)
    throw new PartnerJobError(
      500,
      "partner_tenant_missing",
      "Partner project was not stored"
    );
  return { organizationId, projectId, userId };
}

async function findJob(idOrKey: string) {
  const db = await requireDb();
  const id = partnerJobLookupId(idOrKey);
  const rows = await db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.idempotencyKey, id))
    .limit(1);
  const job = rows[0];
  if (!job) return null;
  const manifest = readPartnerManifest(job.manifest);
  if (!manifest) return null;
  return { job, manifest };
}

async function toView(
  job: StoredJob,
  manifest: PartnerJobManifest
): Promise<PartnerInterpretationJob> {
  const db = await requireDb();
  const runRows = await db
    .select({ status: curationRuns.status })
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.organizationId, job.organizationId),
        eq(curationRuns.caseId, job.caseId)
      )
    );
  let activeRuns = 0;
  let failedRuns = 0;
  let succeededRuns = 0;
  for (const run of runRows) {
    if ((ACTIVE_CURATION_STATUSES as readonly string[]).includes(run.status))
      activeRuns += 1;
    else if (run.status === "failed") failedRuns += 1;
    else if (run.status === "succeeded") succeededRuns += 1;
  }
  const variantRows = manifest.partner.awaitingVcf
    ? []
    : await db
        .select({ heldReason: variants.heldReason })
        .from(variants)
        .where(
          and(
            eq(variants.organizationId, job.organizationId),
            eq(variants.caseId, job.caseId)
          )
        );
  const held = variantRows.filter(row => row.heldReason).length;
  const status = partnerStatusFromParts({
    analysisStatus: job.status,
    awaitingVcf: manifest.partner.awaitingVcf,
    activeRuns,
    failedRuns,
    succeededRuns,
  });
  const parsed = partnerInterpretationJobSchema.safeParse({
    contractVersion: manifest.partner.contractVersion,
    filterContractVersion: manifest.partner.filterContractVersion,
    rulesetVersion: manifest.partner.rulesetVersion,
    id: job.idempotencyKey,
    idempotencyKey: manifest.partner.idempotencyKey,
    externalOrderId: manifest.partner.externalOrderId,
    status,
    track: manifest.partner.track,
    canonicalService: manifest.partner.canonicalService,
    darkGeneResult: manifest.partner.darkGeneResult,
    referenceBuild: manifest.partner.referenceBuild,
    vcfSha256: manifest.partner.vcfSha256,
    databaseVersions: {},
    counts: manifest.partner.awaitingVcf
      ? undefined
      : { kept: variantRows.length - held, held },
    ...(job.errorMessage ? { error: job.errorMessage } : {}),
    ...(manifest.partner.awaitingVcf
      ? {
          vcfUpload: {
            method: "PUT" as const,
            path: partnerVcfUploadPath(job.idempotencyKey),
          },
        }
      : {}),
  });
  if (!parsed.success) {
    throw new PartnerJobError(
      500,
      "partner_job_invalid",
      "Stored partner job does not match the contract"
    );
  }
  return parsed.data;
}

export async function createPartnerInterpretationJob(
  decision: Extract<PartnerInterpretationResult, { accepted: true }>
): Promise<PartnerInterpretationJob> {
  const id = partnerJobStorageKey(decision.idempotencyKey);
  const existing = await findJob(id);
  if (existing) return toView(existing.job, existing.manifest);

  const tenant = await ensurePartnerTenant();
  const manifest = partnerJobManifest(decision.request, decision);
  const db = await requireDb();
  try {
    await db.transaction(async tx => {
      const caseRows = await tx
        .insert(cases)
        .values({
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          caseNumber: id,
          patientAlias: decision.request.externalOrderId,
          purpose: "germline",
          inputType: "vcf",
          status: "queued",
          referenceBuild: decision.request.referenceBuild,
          panelName: `${decision.canonicalService} / ${decision.track}`,
          phenotypeText: decision.request.hpo || null,
          consentClinicalAnalysis: true,
          consentSecondaryFindings: false,
          consentDataUse: false,
          createdBy: tenant.userId,
        })
        .returning({ id: cases.id });
      const caseId = caseRows[0]?.id;
      if (!caseId)
        throw new PartnerJobError(
          500,
          "partner_job_missing",
          "Partner case was not stored"
        );
      await tx.insert(samples).values({
        organizationId: tenant.organizationId,
        caseId,
        sampleCode: decision.request.externalOrderId,
        role: "proband",
        specimenType: "Blood",
      });
      await tx.insert(analysisJobs).values({
        organizationId: tenant.organizationId,
        caseId,
        pipeline: "vcf_ingest",
        status: "queued",
        progressPercent: 0,
        externalJobId: decision.request.externalOrderId,
        idempotencyKey: id,
        manifest,
        createdBy: tenant.userId,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const created = await findJob(id);
  if (!created)
    throw new PartnerJobError(
      500,
      "partner_job_missing",
      "Partner job was not stored"
    );
  return toView(created.job, created.manifest);
}

export async function getPartnerInterpretationJob(
  idOrKey: string
): Promise<PartnerInterpretationJob> {
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  return toView(found.job, found.manifest);
}

export async function uploadPartnerVcf(
  idOrKey: string,
  body: Buffer
): Promise<PartnerInterpretationJob> {
  if (!body.length)
    throw new PartnerJobError(400, "empty_vcf", "VCF body is empty");
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  if (!found.manifest.partner.awaitingVcf) {
    throw new PartnerJobError(
      409,
      "vcf_already_received",
      "VCF was already received for this job"
    );
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== found.manifest.partner.vcfSha256) {
    throw new PartnerJobError(
      400,
      "vcf_checksum_mismatch",
      "VCF checksum does not match the job"
    );
  }

  const fileName = vcfFileName(found.manifest.partner.vcfUri);
  const stored = await storagePut(
    `organizations/${found.job.organizationId}/cases/${found.job.caseId}/files/${fileName}`,
    body,
    fileName.endsWith(".gz") ? "application/gzip" : "text/plain"
  );
  const db = await requireDb();
  const file = await db.transaction(async tx => {
    const locked = await tx
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.id, found.job.id),
          eq(analysisJobs.organizationId, found.job.organizationId)
        )
      )
      .for("update")
      .limit(1);
    const current = readPartnerManifest(locked[0]?.manifest);
    if (!current?.partner.awaitingVcf) {
      throw new PartnerJobError(
        409,
        "vcf_already_received",
        "VCF was already received for this job"
      );
    }
    const inserted = await tx
      .insert(caseFiles)
      .values({
        organizationId: found.job.organizationId,
        caseId: found.job.caseId,
        kind: "vcf",
        fileName,
        storageKey: stored.key,
        storageUrl: stored.url,
        mimeType: fileName.endsWith(".gz") ? "application/gzip" : "text/plain",
        byteSize: body.length,
        sha256: digest,
        status: "verified",
        uploadedBy: found.job.createdBy,
      })
      .returning();
    const fileRow = inserted[0];
    if (!fileRow)
      throw new PartnerJobError(
        500,
        "partner_job_missing",
        "VCF file was not stored"
      );
    await tx
      .update(analysisJobs)
      .set({
        manifest: {
          ...current,
          partner: { ...current.partner, awaitingVcf: false },
        },
      })
      .where(
        and(
          eq(analysisJobs.id, found.job.id),
          eq(analysisJobs.organizationId, found.job.organizationId)
        )
      );
    return fileRow;
  });

  void ingestVcfForJob({
    organizationId: found.job.organizationId,
    caseId: found.job.caseId,
    jobId: found.job.id,
    vcfFile: file,
    referenceBuild: found.manifest.partner.referenceBuild,
    purpose: "germline",
    vcfFilters: found.manifest.vcfFilters,
  }).catch(error => {
    console.error("[partner] vcf ingest failed", {
      jobId: found.job.id,
      error,
    });
  });

  return getPartnerInterpretationJob(found.job.idempotencyKey);
}

export async function listPartnerVariants(
  idOrKey: string
): Promise<PartnerVariantSummary[]> {
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  const db = await requireDb();
  const rows = await db
    .select()
    .from(variants)
    .where(
      and(
        eq(variants.organizationId, found.job.organizationId),
        eq(variants.caseId, found.job.caseId)
      )
    );
  const runs = await db
    .select({
      variantId: curationRuns.variantId,
      status: curationRuns.status,
      summary: curationRuns.summary,
      completedAt: curationRuns.completedAt,
    })
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.organizationId, found.job.organizationId),
        eq(curationRuns.caseId, found.job.caseId)
      )
    );
  const summaryByVariant = new Map<number, (typeof runs)[number]>();
  for (const run of runs) {
    if (!run.variantId || run.status !== "succeeded") continue;
    const current = summaryByVariant.get(run.variantId);
    const runTime = run.completedAt?.getTime() ?? 0;
    const currentTime = current?.completedAt?.getTime() ?? 0;
    if (!current || runTime >= currentTime)
      summaryByVariant.set(run.variantId, run);
  }
  return rows.map(row => {
    const summary = summaryByVariant.get(row.id)?.summary;
    const classification = summary?.classification;
    const parsed = partnerVariantSummarySchema.safeParse({
      variantKey: row.normalizedId,
      chrom: row.chromosome,
      pos: row.position,
      ref: row.referenceAllele,
      alt: row.alternateAllele,
      gene: row.gene ?? "",
      hgvsc: row.hgvsC,
      transcript: row.transcript,
      zygosity: row.zygosity,
      acmgClassification: classification?.label ?? null,
      acmgCriteria: summary?.criteriaCodes ?? [],
      heldReason: row.heldReason,
    });
    if (!parsed.success) {
      throw new PartnerJobError(
        500,
        "variant_invalid",
        "Stored variant does not match the partner summary"
      );
    }
    return parsed.data;
  });
}

export async function getPartnerVariantDocument(
  idOrKey: string,
  variantKey: string
) {
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  const db = await requireDb();
  const key = decodeURIComponent(variantKey);
  const variantRows = await db
    .select({ id: variants.id, normalizedId: variants.normalizedId })
    .from(variants)
    .where(
      and(
        eq(variants.organizationId, found.job.organizationId),
        eq(variants.caseId, found.job.caseId),
        eq(variants.normalizedId, key)
      )
    )
    .limit(1);
  const variant = variantRows[0];
  if (!variant)
    throw new PartnerJobError(
      404,
      "variant_not_found",
      "Variant not found on this job"
    );
  const runRows = await db
    .select()
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.organizationId, found.job.organizationId),
        eq(curationRuns.variantId, variant.id),
        eq(curationRuns.status, "succeeded")
      )
    )
    .orderBy(desc(curationRuns.completedAt))
    .limit(1);
  const run = runRows[0];
  if (!run?.documentKey) {
    throw new PartnerJobError(
      409,
      "document_not_ready",
      "Curation document is not ready"
    );
  }
  const parsed = curationDocumentSchema.safeParse(
    JSON.parse(await storageGetText(run.documentKey))
  );
  if (!parsed.success) {
    throw new PartnerJobError(
      500,
      "document_invalid",
      "Stored curation document does not match contract v1"
    );
  }
  return {
    runId: run.id,
    variantKey: variant.normalizedId,
    documentHash: run.documentHash,
    document: await alignClinvarClaim(parsed.data),
  };
}

export function partnerErrorStatus(error: unknown): {
  status: number;
  body: { error: string; message?: string };
} {
  if (error instanceof PartnerJobError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message },
    };
  }
  if (
    error instanceof TRPCError &&
    error.message === "Database is unavailable"
  ) {
    return { status: 503, body: { error: "database_unavailable" } };
  }
  console.error("[partner]", error);
  return { status: 500, body: { error: "partner_job_failed" } };
}

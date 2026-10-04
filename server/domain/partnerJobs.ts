import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  analysisJobs,
  caseFiles,
  cases,
  curationRunEvents,
  germlinePanels,
  curationRuns,
  organizationMembers,
  organizations,
  projects,
  samples,
  users,
  variants,
} from "../../drizzle/schema";
import {
  interpretDarkGenes,
  partnerDarkGeneInputSchema,
  partnerDarkGenesSchema,
  type PartnerDarkGenes,
} from "@shared/darkGenes";
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
  samePartnerOrderAction,
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

async function findLatestJobByOrder(externalOrderId: string) {
  const orderId = externalOrderId.trim();
  if (!orderId) return null;
  const db = await requireDb();
  const rows = await db
    .select({ job: analysisJobs, caseStatus: cases.status })
    .from(analysisJobs)
    .innerJoin(
      cases,
      and(
        eq(cases.id, analysisJobs.caseId),
        eq(cases.organizationId, analysisJobs.organizationId)
      )
    )
    .where(eq(analysisJobs.externalJobId, orderId))
    .orderBy(desc(analysisJobs.updatedAt), desc(analysisJobs.id));
  for (const row of rows) {
    const manifest = readPartnerManifest(row.job.manifest);
    if (manifest?.partner.externalOrderId === orderId) {
      return { job: row.job, manifest, caseStatus: row.caseStatus };
    }
  }
  return null;
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

async function syncPartnerPgxFlags(
  found: NonNullable<Awaited<ReturnType<typeof findJob>>>,
  request: { includePgx: boolean; includeApoePgx: boolean }
) {
  const currentPgx = found.manifest.partner.includePgx ?? false;
  const currentApoe = found.manifest.partner.includeApoePgx ?? false;
  if (currentPgx === request.includePgx && currentApoe === request.includeApoePgx) return found;
  const manifest: PartnerJobManifest = {
    ...found.manifest,
    partner: {
      ...found.manifest.partner,
      includePgx: request.includePgx,
      includeApoePgx: request.includeApoePgx,
    },
  };
  const db = await requireDb();
  await db
    .update(analysisJobs)
    .set({ manifest })
    .where(
      and(
        eq(analysisJobs.id, found.job.id),
        eq(analysisJobs.organizationId, found.job.organizationId)
      )
    );
  return { job: found.job, manifest };
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
  let queuedRuns = 0;
  let runningRuns = 0;
  let failedRuns = 0;
  let succeededRuns = 0;
  for (const run of runRows) {
    if (run.status === "queued") queuedRuns += 1;
    if (run.status === "loading" || run.status === "running") runningRuns += 1;
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
  let status = partnerStatusFromParts({
    analysisStatus: job.status,
    awaitingVcf: manifest.partner.awaitingVcf,
    activeRuns,
    failedRuns,
    succeededRuns,
  });
  // Ingest marks the case ready before the classifier queue is filled. Until that
  // queue exists, the job is still running so the portal does not read an empty result.
  if (
    status === "succeeded" &&
    manifest.partner.classificationQueued !== true &&
    activeRuns === 0 &&
    succeededRuns === 0 &&
    failedRuns === 0
  ) {
    status = "running";
  }
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
    includePgx: manifest.partner.includePgx ?? false,
    includeApoePgx: manifest.partner.includeApoePgx ?? false,
    ...(manifest.partner.panelCode ? { panelCode: manifest.partner.panelCode } : {}),
    ...(manifest.partner.panelName ? { panelName: manifest.partner.panelName } : {}),
    referenceBuild: manifest.partner.referenceBuild,
    vcfSha256: manifest.partner.vcfSha256,
    databaseVersions: {},
    counts: manifest.partner.awaitingVcf
      ? undefined
      : { kept: variantRows.length - held, held },
    classification: manifest.partner.awaitingVcf
      ? undefined
      : {
          queued: queuedRuns,
          running: runningRuns,
          succeeded: succeededRuns,
          failed: failedRuns,
        },
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

async function reopenFailedPartnerJob(found: {
  job: StoredJob;
  manifest: PartnerJobManifest;
}): Promise<PartnerInterpretationJob> {
  const db = await requireDb();
  const manifest: PartnerJobManifest = {
    ...found.manifest,
    partner: { ...found.manifest.partner, classificationQueued: false },
  };
  await db
    .update(analysisJobs)
    .set({
      status: "queued",
      errorMessage: null,
      completedAt: null,
      progressPercent: 0,
      startedAt: null,
      manifest,
    })
    .where(
      and(
        eq(analysisJobs.id, found.job.id),
        eq(analysisJobs.organizationId, found.job.organizationId)
      )
    );
  await db
    .update(cases)
    .set({ status: "queued" })
    .where(
      and(
        eq(cases.id, found.job.caseId),
        eq(cases.organizationId, found.job.organizationId)
      )
    );
  await db
    .delete(variants)
    .where(
      and(
        eq(variants.organizationId, found.job.organizationId),
        eq(variants.caseId, found.job.caseId)
      )
    );
  if (!manifest.partner.awaitingVcf) {
    const [file] = await db
      .select()
      .from(caseFiles)
      .where(
        and(
          eq(caseFiles.organizationId, found.job.organizationId),
          eq(caseFiles.caseId, found.job.caseId),
          eq(caseFiles.kind, "vcf")
        )
      )
      .limit(1);
    if (file) {
      void ingestVcfForJob({
        organizationId: found.job.organizationId,
        caseId: found.job.caseId,
        jobId: found.job.id,
        vcfFile: file,
        referenceBuild: manifest.partner.referenceBuild,
        purpose: "germline",
        vcfFilters: manifest.vcfFilters,
      }).catch(error => {
        console.error("[partner] vcf ingest retry failed", {
          jobId: found.job.id,
          error,
        });
      });
    }
  }
  return toView(
    { ...found.job, status: "queued", errorMessage: null },
    manifest
  );
}

/** A changed panel or track for an order already on file replaces that case. */
async function replacePartnerOrder(
  found: {
    job: StoredJob;
    manifest: PartnerJobManifest;
  },
  decision: Extract<PartnerInterpretationResult, { accepted: true }>,
  id: string
): Promise<PartnerInterpretationJob> {
  const manifest = partnerJobManifest(decision.request, decision);
  const db = await requireDb();
  const [file] = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.organizationId, found.job.organizationId),
        eq(caseFiles.caseId, found.job.caseId),
        eq(caseFiles.kind, "vcf")
      )
    )
    .limit(1);
  const sameVcf = file?.sha256 === decision.request.vcf.sha256;
  if (sameVcf) manifest.partner.awaitingVcf = false;
  await db.transaction(async tx => {
    await tx
      .update(cases)
      .set({
        caseNumber: id,
        status: "queued",
        referenceBuild: decision.request.referenceBuild,
        panelName:
          decision.request.panelName ||
          `${decision.canonicalService} / ${decision.track}`,
        phenotypeText: decision.request.hpo || null,
      })
      .where(
        and(
          eq(cases.id, found.job.caseId),
          eq(cases.organizationId, found.job.organizationId)
        )
      );
    await tx
      .update(analysisJobs)
      .set({
        status: "queued",
        errorMessage: null,
        completedAt: null,
        progressPercent: 0,
        startedAt: null,
        idempotencyKey: id,
        manifest,
      })
      .where(
        and(
          eq(analysisJobs.id, found.job.id),
          eq(analysisJobs.organizationId, found.job.organizationId)
        )
      );
    await tx
      .delete(variants)
      .where(
        and(
          eq(variants.organizationId, found.job.organizationId),
          eq(variants.caseId, found.job.caseId)
        )
      );
  });
  if (sameVcf && file) {
    void ingestVcfForJob({
      organizationId: found.job.organizationId,
      caseId: found.job.caseId,
      jobId: found.job.id,
      vcfFile: file,
      referenceBuild: manifest.partner.referenceBuild,
      purpose: "germline",
      vcfFilters: manifest.vcfFilters,
    }).catch(error => {
      console.error("[partner] vcf ingest replace failed", {
        jobId: found.job.id,
        error,
      });
    });
  }
  return toView(
    { ...found.job, status: "queued", errorMessage: null, idempotencyKey: id },
    manifest
  );
}

/** A saved panel code replaces the request gene list before the job is accepted. */
export async function applyPartnerPanel(
  input: unknown
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  if (!input || typeof input !== "object") return { ok: true, body: input };
  const record = input as Record<string, unknown>;
  const code = typeof record.panelCode === "string" ? record.panelCode.trim() : "";
  if (!code) return { ok: true, body: input };
  const db = await requireDb();
  const rows = await db
    .select({ name: germlinePanels.name, genes: germlinePanels.genes })
    .from(germlinePanels)
    .where(sql`lower(${germlinePanels.code}) = ${code.toLowerCase()}`);
  if (rows.length !== 1) {
    return {
      ok: false,
      message:
        rows.length === 0
          ? `Panel ${code} was not found`
          : `Panel ${code} matches more than one saved list`,
    };
  }
  const genes = (rows[0]?.genes ?? []).map(gene => gene.trim()).filter(Boolean);
  if (!genes.length) return { ok: false, message: `Panel ${code} has no genes` };
  return {
    ok: true,
    body: { ...record, panelCode: code, panelName: rows[0]?.name, genes: genes.join(",") },
  };
}

export async function createPartnerInterpretationJob(
  decision: Extract<PartnerInterpretationResult, { accepted: true }>
): Promise<PartnerInterpretationJob> {
  const id = partnerJobStorageKey(decision.idempotencyKey);
  const existing = await findJob(id);
  if (existing) {
    const synced = await syncPartnerPgxFlags(existing, decision.request);
    if (synced.job.status === "failed") return reopenFailedPartnerJob(synced);
    return toView(synced.job, synced.manifest);
  }

  const prior = await findLatestJobByOrder(decision.request.externalOrderId);
  if (prior) {
    const action = samePartnerOrderAction({
      storedIdempotencyKey: prior.manifest.partner.idempotencyKey,
      incomingIdempotencyKey: decision.idempotencyKey,
      jobStatus: prior.job.status,
      caseStatus: prior.caseStatus,
    });
    if (action === "keep") return toView(prior.job, prior.manifest);
    if (action === "return" || action === "reopen") {
      const synced = await syncPartnerPgxFlags(prior, decision.request);
      if (action === "reopen") return reopenFailedPartnerJob(synced);
      return toView(synced.job, synced.manifest);
    }
    return replacePartnerOrder(prior, decision, id);
  }

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
          panelName: decision.request.panelName || `${decision.canonicalService} / ${decision.track}`,
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

export async function submitPartnerDarkGenes(
  idOrKey: string,
  input: unknown
): Promise<PartnerDarkGenes> {
  const parsed = partnerDarkGeneInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PartnerJobError(
      400,
      "invalid_dark_genes",
      "Dark gene report text is missing or too large"
    );
  }
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  if (found.manifest.partner.darkGeneResult === "not_requested") {
    throw new PartnerJobError(
      422,
      "dark_genes_not_requested",
      "This track does not include a dark gene result"
    );
  }
  const interpreted = interpretDarkGenes(parsed.data);
  const stored = partnerDarkGenesSchema.parse({
    ...interpreted,
    status: interpreted.status === "deferred" ? "absent" : interpreted.status,
  });
  const db = await requireDb();
  await db
    .update(analysisJobs)
    .set({
      manifest: {
        ...found.manifest,
        partner: {
          ...found.manifest.partner,
          darkGeneResult: stored.status,
          darkGenes: stored,
        },
      },
    })
    .where(
      and(
        eq(analysisJobs.id, found.job.id),
        eq(analysisJobs.organizationId, found.job.organizationId)
      )
    );
  return stored;
}

export async function getPartnerDarkGenes(
  idOrKey: string
): Promise<PartnerDarkGenes> {
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  if (found.manifest.partner.darkGeneResult === "not_requested") {
    throw new PartnerJobError(
      422,
      "dark_genes_not_requested",
      "This track does not include a dark gene result"
    );
  }
  const stored = found.manifest.partner.darkGenes;
  if (!stored) {
    return { status: "deferred", detailed_sections: [], cftr_ivs9_eh: null };
  }
  const parsed = partnerDarkGenesSchema.safeParse(stored);
  if (!parsed.success) {
    throw new PartnerJobError(
      500,
      "dark_genes_invalid",
      "Stored dark gene result does not match the contract"
    );
  }
  return parsed.data;
}

export async function getPartnerInterpretationJob(
  idOrKey: string
): Promise<PartnerInterpretationJob> {
  const found = await findJob(idOrKey);
  if (!found)
    throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  return toView(found.job, found.manifest);
}

/** Waiting variants are cancelled. A variant a worker already started is left to finish. */
export async function cancelPartnerClassification(
  idOrKey: string
): Promise<{ job: PartnerInterpretationJob; cancelled: number }> {
  const found = await findJob(idOrKey);
  if (!found) throw new PartnerJobError(404, "job_not_found", "Partner job not found");
  const db = await requireDb();
  const cancelled = await db
    .update(curationRuns)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(curationRuns.organizationId, found.job.organizationId),
        eq(curationRuns.caseId, found.job.caseId),
        eq(curationRuns.status, "queued")
      )
    )
    .returning({ id: curationRuns.id });
  if (cancelled.length) {
    await db.insert(curationRunEvents).values(
      cancelled.map(row => ({
        organizationId: found.job.organizationId,
        runId: row.id,
        status: "cancelled" as const,
        message: "Cancelled before a worker claimed it.",
        progressPercent: 0,
      }))
    );
  }
  return { job: await toView(found.job, found.manifest), cancelled: cancelled.length };
}

export async function listPartnerJobProgress(
  externalOrderIds: string[]
): Promise<PartnerInterpretationJob[]> {
  const ids = [...new Set(externalOrderIds.map(id => id.trim()).filter(Boolean))].slice(0, 100);
  if (!ids.length) return [];
  const db = await requireDb();
  const rows = await db
    .select()
    .from(analysisJobs)
    .where(inArray(analysisJobs.externalJobId, ids))
    .orderBy(desc(analysisJobs.updatedAt));
  const seen = new Set<string>();
  const jobs: PartnerInterpretationJob[] = [];
  for (const job of rows) {
    const manifest = readPartnerManifest(job.manifest);
    const orderId = manifest?.partner.externalOrderId;
    if (!manifest || !orderId || seen.has(orderId) || !ids.includes(orderId)) continue;
    seen.add(orderId);
    jobs.push(await toView(job, manifest));
  }
  return jobs;
}

export async function getPartnerJobByExternalOrder(
  externalOrderId: string
): Promise<PartnerInterpretationJob | null> {
  const orderId = externalOrderId.trim();
  if (!orderId) return null;
  const db = await requireDb();
  const rows = await db
    .select()
    .from(analysisJobs)
    .where(eq(analysisJobs.externalJobId, orderId))
    .orderBy(desc(analysisJobs.updatedAt));
  for (const job of rows) {
    const manifest = readPartnerManifest(job.manifest);
    if (manifest?.partner.externalOrderId === orderId) return toView(job, manifest);
  }
  return null;
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

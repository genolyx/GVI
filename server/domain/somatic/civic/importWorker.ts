import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  somaticCivicImportCheckpoints,
  somaticCivicImportJobs,
  somaticCivicRawArchives,
  somaticKnowledgeEvidenceRecords,
  somaticKnowledgeProviders,
  somaticKnowledgeReleases,
} from "../../../../drizzle/schema";
import { storagePut } from "../../../storage";
import { requireDb } from "../../tenant";
import { offlineEvidenceInsertValues } from "../offlineKnowledge";
import {
  CivicClientError,
  createCivicGraphQlClient,
  type CivicGraphQlClient,
  type CivicGraphQlResult,
} from "./client";
import { evaluateMolecularProfile, matchCivicVariant } from "./matching";
import { normalizeAcceptedEvidence } from "./normalize";
import type { CivicOperationName } from "./queries";
import type {
  CivicEvidenceItem,
  CivicGene,
  CivicMolecularProfile,
  CivicPageInfo,
  CivicVariant,
  NormalizedVariantContext,
} from "./types";

type ImportJob = {
  id: number;
  organizationId: number;
  releaseId: number;
  scopeConfig: NormalizedVariantContext[];
  snapshotHash: string;
  schemaHash: string;
  attemptCount: number;
  maxAttempts: number;
};

type ImportStats = {
  requests: number;
  variantsConsidered: number;
  variantsMatched: number;
  profilesConsidered: number;
  evidenceAccepted: number;
  evidenceImported: number;
};

class PartialImportError extends Error {
  constructor(
    message: string,
    readonly warning: string
  ) {
    super(message);
  }
}

class CancelledImportError extends Error {}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const POLL_MS = positiveIntegerEnv("CIVIC_IMPORT_POLL_MS", 5_000);
const LEASE_SECONDS = positiveIntegerEnv("CIVIC_IMPORT_LEASE_SECONDS", 300);
const REQUEST_TIMEOUT_MS = positiveIntegerEnv(
  "CIVIC_IMPORT_REQUEST_TIMEOUT_MS",
  15_000
);
const RETRY_COUNT = Math.min(
  3,
  positiveIntegerEnv("CIVIC_IMPORT_REQUEST_RETRIES", 3)
);
const REQUEST_INTERVAL_MS = positiveIntegerEnv(
  "CIVIC_IMPORT_REQUEST_INTERVAL_MS",
  1_000
);
const PAGE_SIZE = Math.min(
  100,
  positiveIntegerEnv("CIVIC_IMPORT_PAGE_SIZE", 25)
);
const MAX_PAGES = positiveIntegerEnv("CIVIC_IMPORT_MAX_PAGES", 100);

export function civicImportRetryDelayMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, attemptCount - 1));
}

async function claimJob(
  workerId: string,
  leaseSeconds: number
): Promise<ImportJob | null> {
  const db = await requireDb();
  await db.execute(sql`
    UPDATE somatic_civic_import_jobs
    SET status = 'cancelled',
        "leaseOwner" = NULL,
        "leaseExpiresAt" = NULL,
        "completedAt" = now(),
        "updatedAt" = now()
    WHERE status = 'running'
      AND "cancelRequestedAt" IS NOT NULL
      AND "leaseExpiresAt" <= now()
  `);
  const result = await db.execute<ImportJob>(sql`
    WITH candidate AS (
      SELECT id
      FROM somatic_civic_import_jobs
      WHERE "attemptCount" < "maxAttempts"
        AND (
          (status = 'queued' AND "availableAt" <= now())
          OR (status = 'running' AND "leaseExpiresAt" <= now())
        )
        AND "cancelRequestedAt" IS NULL
      ORDER BY "availableAt" ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE somatic_civic_import_jobs AS job
    SET status = 'running',
        "attemptCount" = job."attemptCount" + 1,
        "leaseOwner" = ${workerId},
        "leaseExpiresAt" = now() + (${leaseSeconds} * interval '1 second'),
        "startedAt" = COALESCE(job."startedAt", now()),
        "completedAt" = NULL,
        error = NULL,
        "updatedAt" = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job."organizationId", job."releaseId",
      job."scopeConfig", job."snapshotHash", job."schemaHash",
      job."attemptCount", job."maxAttempts"
  `);
  return result.rows[0] ?? null;
}

async function assertNotCancelled(job: ImportJob): Promise<void> {
  const db = await requireDb();
  const rows = await db
    .select({
      status: somaticCivicImportJobs.status,
      cancelRequestedAt: somaticCivicImportJobs.cancelRequestedAt,
    })
    .from(somaticCivicImportJobs)
    .where(
      and(
        eq(somaticCivicImportJobs.id, job.id),
        eq(somaticCivicImportJobs.organizationId, job.organizationId)
      )
    )
    .limit(1);
  if (
    !rows[0] ||
    rows[0].status === "cancelled" ||
    rows[0].cancelRequestedAt
  ) {
    throw new CancelledImportError("CIViC import cancelled.");
  }
}

async function checkpoint(input: {
  job: ImportJob;
  scopeIndex: number;
  operationName: string;
  pageNumber?: number;
  cursor?: string | null;
  status: "started" | "complete" | "partial" | "failed";
  details?: Record<string, unknown>;
}) {
  const db = await requireDb();
  await db
    .insert(somaticCivicImportCheckpoints)
    .values({
      organizationId: input.job.organizationId,
      releaseId: input.job.releaseId,
      jobId: input.job.id,
      scopeIndex: input.scopeIndex,
      operationName: input.operationName,
      pageNumber: input.pageNumber ?? 0,
      cursor: input.cursor ?? null,
      status: input.status,
      details: input.details ?? {},
    })
    .onConflictDoUpdate({
      target: [
        somaticCivicImportCheckpoints.organizationId,
        somaticCivicImportCheckpoints.jobId,
        somaticCivicImportCheckpoints.scopeIndex,
        somaticCivicImportCheckpoints.operationName,
        somaticCivicImportCheckpoints.pageNumber,
      ],
      set: {
        cursor: input.cursor ?? null,
        status: input.status,
        details: input.details ?? {},
      },
    });
}

async function archiveResponse(
  job: ImportJob,
  scopeIndex: number,
  operationName: CivicOperationName,
  pageNumber: number,
  response: CivicGraphQlResult<unknown>
) {
  const hash =
    response.envelope.bodySha256 ??
    createHash("sha256").update(response.rawBody).digest("hex");
  const base = `organizations/${job.organizationId}/imports/${job.id}/${scopeIndex}-${operationName}-${pageNumber}-${response.envelope.requestId}`;
  const [body, envelope] = await Promise.all([
    storagePut(`${base}.json`, response.rawBody, "application/json"),
    storagePut(
      `${base}.envelope.json`,
      JSON.stringify(response.envelope),
      "application/json"
    ),
  ]);
  const db = await requireDb();
  await db
    .insert(somaticCivicRawArchives)
    .values({
      organizationId: job.organizationId,
      releaseId: job.releaseId,
      jobId: job.id,
      scopeIndex,
      operationName,
      pageNumber,
      requestId: response.envelope.requestId,
      rawBodyHash: hash,
      storageKey: body.key,
      storageUrl: body.url,
      envelopeStorageKey: envelope.key,
      envelopeStorageUrl: envelope.url,
      byteSize: Buffer.byteLength(response.rawBody),
      envelope: response.envelope as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();
}

async function executeArchived<T>(
  client: CivicGraphQlClient,
  job: ImportJob,
  stats: ImportStats,
  scopeIndex: number,
  operationName: CivicOperationName,
  pageNumber: number,
  variables: Record<string, unknown>,
  checkpointName: string = operationName
): Promise<CivicGraphQlResult<T>> {
  await assertNotCancelled(job);
  await checkpoint({
    job,
    scopeIndex,
    operationName: checkpointName,
    pageNumber,
    status: "started",
    details: { variables },
  });
  try {
    const result = await client.execute<T>(operationName, variables);
    await archiveResponse(
      job,
      scopeIndex,
      operationName,
      pageNumber,
      result as CivicGraphQlResult<unknown>
    );
    stats.requests += 1;
    const db = await requireDb();
    await db
      .update(somaticCivicImportJobs)
      .set({ stats })
      .where(
        and(
          eq(somaticCivicImportJobs.id, job.id),
          eq(somaticCivicImportJobs.organizationId, job.organizationId)
        )
      );
    await checkpoint({
      job,
      scopeIndex,
      operationName: checkpointName,
      pageNumber,
      status: "complete",
      details: {
        requestId: result.envelope.requestId,
        rawBodyHash: result.envelope.bodySha256,
      },
    });
    return result;
  } catch (error) {
    await checkpoint({
      job,
      scopeIndex,
      operationName: checkpointName,
      pageNumber,
      status: "failed",
      details: {
        message: error instanceof Error ? error.message : "Request failed.",
      },
    });
    throw error;
  }
}

async function paged<TData, TNode>(options: {
  client: CivicGraphQlClient;
  job: ImportJob;
  stats: ImportStats;
  scopeIndex: number;
  operationName: "CandidateVariants" | "CandidateProfiles" | "AcceptedEvidence";
  checkpointName?: string;
  variables: Record<string, unknown>;
  connection: (data: TData) => {
    nodes: TNode[];
    pageInfo: CivicPageInfo;
    totalCount?: number;
  };
  onPage?: (
    nodes: TNode[],
    response: CivicGraphQlResult<TData>
  ) => Promise<void>;
}): Promise<TNode[]> {
  const items = new Map<string, TNode>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await executeArchived<TData>(
      options.client,
      options.job,
      options.stats,
      options.scopeIndex,
      options.operationName,
      page,
      { ...options.variables, after: cursor },
      options.checkpointName
    );
    const connection = options.connection(response.data);
    for (const item of connection.nodes) {
      const id = String((item as { id?: unknown }).id ?? JSON.stringify(item));
      items.set(id, item);
    }
    await options.onPage?.(connection.nodes, response);
    await checkpoint({
      job: options.job,
      scopeIndex: options.scopeIndex,
      operationName: options.checkpointName ?? options.operationName,
      pageNumber: page,
      cursor,
      status: "complete",
      details: {
        requestId: response.envelope.requestId,
        itemCount: connection.nodes.length,
        hasNextPage: connection.pageInfo.hasNextPage,
      },
    });
    if (!connection.pageInfo.hasNextPage) {
      await checkpoint({
        job: options.job,
        scopeIndex: options.scopeIndex,
        operationName: `${options.checkpointName ?? options.operationName}:completed`,
        status: "complete",
        details: { pages: page, itemCount: items.size },
      });
      return Array.from(items.values());
    }
    const next = connection.pageInfo.endCursor;
    if (!next || next === cursor || cursors.has(next)) {
      throw new PartialImportError(
        `${options.operationName} pagination cursor did not advance.`,
        `CURSOR_NOT_ADVANCING:${options.scopeIndex}:${options.operationName}`
      );
    }
    cursors.add(next);
    cursor = next;
  }
  throw new PartialImportError(
    `${options.operationName} exceeded the configured page limit.`,
    `PAGE_LIMIT:${options.scopeIndex}:${options.operationName}`
  );
}

async function importScope(
  client: CivicGraphQlClient,
  job: ImportJob,
  stats: ImportStats,
  warnings: string[],
  scopeIndex: number,
  variant: NormalizedVariantContext
) {
  const geneResponse = await executeArchived<{ gene: CivicGene | null }>(
    client,
    job,
    stats,
    scopeIndex,
    "ResolveGene",
    0,
    { symbol: variant.geneSymbol }
  );
  const gene = geneResponse.data.gene;
  await checkpoint({
    job,
    scopeIndex,
    operationName: "ResolveGene:completed",
    status: "complete",
    details: { found: Boolean(gene), geneId: gene?.id ?? null },
  });
  if (!gene || gene.deprecated) {
    warnings.push(`GENE_NOT_RESOLVED:${scopeIndex}:${variant.geneSymbol}`);
    return;
  }

  const searchName =
    variant.hgvsP ??
    variant.hgvsC ??
    variant.variantClass ??
    variant.normalizedVariantId;
  const candidates = await paged<
    { variants: { nodes: CivicVariant[]; pageInfo: CivicPageInfo } },
    CivicVariant
  >({
    client,
    job,
    stats,
    scopeIndex,
    operationName: "CandidateVariants",
    variables: { geneId: gene.id, name: searchName },
    connection: data => data.variants,
  });
  stats.variantsConsidered += candidates.length;

  const matched: Array<{ civicVariant: CivicVariant; match: ReturnType<typeof matchCivicVariant> }> = [];
  for (const candidate of candidates) {
    const detail = await executeArchived<{ variant: CivicVariant | null }>(
      client,
      job,
      stats,
      scopeIndex,
      "VariantDetail",
      candidate.id,
      { variantId: candidate.id }
    );
    if (!detail.data.variant) continue;
    const match = matchCivicVariant(variant, detail.data.variant);
    if (match !== "NONE") matched.push({ civicVariant: detail.data.variant, match });
  }
  await checkpoint({
    job,
    scopeIndex,
    operationName: "VariantDetail:completed",
    status: "complete",
    details: { considered: candidates.length, matched: matched.length },
  });
  stats.variantsMatched += matched.length;

  for (const selected of matched) {
    const profiles = await paged<
      {
        molecularProfiles: {
          nodes: CivicMolecularProfile[];
          pageInfo: CivicPageInfo;
        };
      },
      CivicMolecularProfile
    >({
      client,
      job,
      stats,
      scopeIndex,
      operationName: "CandidateProfiles",
      checkpointName: `CandidateProfiles:${selected.civicVariant.id}`,
      variables: { variantId: selected.civicVariant.id },
      connection: data => data.molecularProfiles,
    });
    stats.profilesConsidered += profiles.length;
    for (const profile of profiles) {
      const profileMatch = evaluateMolecularProfile(
        profile,
        new Set([selected.civicVariant.id])
      );
      await paged<
        {
          evidenceItems: {
            nodes: CivicEvidenceItem[];
            pageInfo: CivicPageInfo;
            totalCount?: number;
          };
        },
        CivicEvidenceItem
      >({
        client,
        job,
        stats,
        scopeIndex,
        operationName: "AcceptedEvidence",
        checkpointName: `AcceptedEvidence:${profile.id}`,
        variables: { mpId: profile.id, first: PAGE_SIZE },
        connection: data => data.evidenceItems,
        onPage: async (evidenceItems, response) => {
          const normalized = evidenceItems.flatMap(evidence => {
            const record = normalizeAcceptedEvidence({
              variant,
              evidence,
              profile,
              variantMatch: selected.match,
              profileMatch,
              rawBodySha256:
                response.envelope.bodySha256 ??
                createHash("sha256").update(response.rawBody).digest("hex"),
              requestId: response.envelope.requestId,
              fetchedAt: response.envelope.receivedAtUTC,
              snapshotId: job.snapshotHash,
              schemaHash: job.schemaHash,
              doidVersion: process.env.CIVIC_DOID_VERSION ?? "CIViC-current",
            });
            return record ? [record] : [];
          });
          stats.evidenceAccepted += normalized.length;
          if (!normalized.length) return;
          const db = await requireDb();
          const inserted = await db
            .insert(somaticKnowledgeEvidenceRecords)
            .values(
              normalized.map(record =>
                offlineEvidenceInsertValues(
                  job.organizationId,
                  job.releaseId,
                  record
                )
              )
            )
            .onConflictDoNothing()
            .returning({ id: somaticKnowledgeEvidenceRecords.id });
          stats.evidenceImported += inserted.length;
        },
      });
    }
  }
}

async function deriveContentHash(job: ImportJob): Promise<string> {
  const db = await requireDb();
  const rows = await db
    .select({
      sourceRecordId: somaticKnowledgeEvidenceRecords.sourceRecordId,
      rawResponseHash: somaticKnowledgeEvidenceRecords.rawResponseHash,
    })
    .from(somaticKnowledgeEvidenceRecords)
    .where(
      and(
        eq(somaticKnowledgeEvidenceRecords.organizationId, job.organizationId),
        eq(somaticKnowledgeEvidenceRecords.releaseId, job.releaseId),
        sql`${somaticKnowledgeEvidenceRecords.payload}->>'provider' = 'CIVIC'`
      )
    );
  return createHash("sha256")
    .update(
      rows
        .map(row => `${row.sourceRecordId}\0${row.rawResponseHash}`)
        .sort()
        .join("\n")
    )
    .digest("hex");
}

async function processJob(job: ImportJob): Promise<{
  stats: ImportStats;
  warnings: string[];
}> {
  const db = await requireDb();
  const releases = await db
    .select({
      status: somaticKnowledgeReleases.status,
      providerCode: somaticKnowledgeProviders.code,
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
        eq(somaticKnowledgeReleases.id, job.releaseId),
        eq(somaticKnowledgeReleases.organizationId, job.organizationId)
      )
    )
    .limit(1);
  if (
    releases[0]?.status !== "draft" ||
    releases[0].providerCode.trim().toUpperCase() !== "CIVIC"
  ) {
    throw new Error("Target release is not a draft CIVIC release.");
  }
  // A retry rebuilds the draft from a clean snapshot. Keeping rows written by
  // an interrupted attempt could otherwise combine evidence fetched at
  // different times while the unique source-record key silently keeps stale
  // values.
  await db
    .delete(somaticKnowledgeEvidenceRecords)
    .where(
      and(
        eq(somaticKnowledgeEvidenceRecords.organizationId, job.organizationId),
        eq(somaticKnowledgeEvidenceRecords.releaseId, job.releaseId)
      )
    );
  const client = createCivicGraphQlClient({
    bearerToken: process.env.CIVIC_API_KEY || undefined,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retryCount: RETRY_COUNT,
    cacheTtlMs: 0,
    minimumRequestIntervalMs: REQUEST_INTERVAL_MS,
  });
  const stats: ImportStats = {
    requests: 0,
    variantsConsidered: 0,
    variantsMatched: 0,
    profilesConsidered: 0,
    evidenceAccepted: 0,
    evidenceImported: 0,
  };
  const warnings: string[] = [];
  for (const [scopeIndex, variant] of Array.from(job.scopeConfig.entries())) {
    try {
      await importScope(client, job, stats, warnings, scopeIndex, variant);
    } catch (error) {
      if (
        error instanceof CancelledImportError ||
        error instanceof PartialImportError
      ) {
        throw error;
      }
      if (error instanceof CivicClientError && stats.requests > 0) {
        throw new PartialImportError(
          error.message,
          `${error.code}:${scopeIndex}:${error.requestId}`
        );
      }
      throw error;
    }
  }
  await assertNotCancelled(job);
  const contentHash = await deriveContentHash(job);
  const updated = await db
    .update(somaticKnowledgeReleases)
    .set({ contentHash, importedAt: new Date() })
    .where(
      and(
        eq(somaticKnowledgeReleases.id, job.releaseId),
        eq(somaticKnowledgeReleases.organizationId, job.organizationId),
        eq(somaticKnowledgeReleases.status, "draft")
      )
    )
    .returning({ id: somaticKnowledgeReleases.id });
  if (!updated[0]) throw new Error("Target CIViC release is no longer draft.");
  return { stats, warnings };
}

async function updateTerminal(
  job: ImportJob,
  workerId: string,
  status: "partial" | "complete" | "failed" | "cancelled",
  values: {
    stats?: ImportStats;
    warnings?: string[];
    error?: Record<string, unknown> | null;
  }
) {
  const db = await requireDb();
  await db
    .update(somaticCivicImportJobs)
    .set({
      status,
      stats: values.stats,
      warnings: values.warnings,
      error: values.error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(somaticCivicImportJobs.id, job.id),
        eq(somaticCivicImportJobs.organizationId, job.organizationId),
        eq(somaticCivicImportJobs.leaseOwner, workerId)
      )
    );
}

async function retryOrFail(job: ImportJob, workerId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "CIViC import failed.";
  const db = await requireDb();
  if (
    (!(error instanceof CivicClientError) || error.retryable) &&
    job.attemptCount < job.maxAttempts
  ) {
    await db
      .update(somaticCivicImportJobs)
      .set({
        status: "queued",
        availableAt: new Date(Date.now() + civicImportRetryDelayMs(job.attemptCount)),
        leaseOwner: null,
        leaseExpiresAt: null,
        error: {
          code:
            error instanceof CivicClientError ? error.code : "IMPORT_FAILED",
          message,
          retryScheduled: true,
          requestId:
            error instanceof CivicClientError ? error.requestId : undefined,
        },
      })
      .where(
        and(
          eq(somaticCivicImportJobs.id, job.id),
          eq(somaticCivicImportJobs.organizationId, job.organizationId),
          eq(somaticCivicImportJobs.leaseOwner, workerId)
        )
      );
    return;
  }
  await updateTerminal(job, workerId, "failed", {
    error: {
      message,
      code: error instanceof CivicClientError ? error.code : "IMPORT_FAILED",
      retryScheduled: false,
    },
  });
}

export async function runCivicImportWorkerOnce(
  workerId: string,
  leaseSeconds = LEASE_SECONDS
): Promise<boolean> {
  const job = await claimJob(workerId, leaseSeconds);
  if (!job) return false;
  const heartbeat = setInterval(async () => {
    const db = await requireDb();
    await db
      .update(somaticCivicImportJobs)
      .set({ leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) })
      .where(
        and(
          eq(somaticCivicImportJobs.id, job.id),
          eq(somaticCivicImportJobs.organizationId, job.organizationId),
          eq(somaticCivicImportJobs.leaseOwner, workerId),
          eq(somaticCivicImportJobs.status, "running")
        )
      );
  }, Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3)));
  heartbeat.unref?.();
  try {
    const result = await processJob(job);
    await updateTerminal(job, workerId, "complete", {
      stats: result.stats,
      warnings: result.warnings,
      error: null,
    });
  } catch (error) {
    if (error instanceof CancelledImportError) {
      await updateTerminal(job, workerId, "cancelled", { error: null });
    } else if (error instanceof PartialImportError) {
      await updateTerminal(job, workerId, "partial", {
        warnings: [error.warning],
        error: { message: error.message, code: "PARTIAL_UPSTREAM" },
      });
    } else {
      await retryOrFail(job, workerId, error);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function startCivicImportWorker(options?: {
  workerId?: string;
  pollMs?: number;
  leaseSeconds?: number;
}) {
  const workerId =
    options?.workerId ??
    `civic-import-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const pollMs = options?.pollMs ?? POLL_MS;
  const leaseSeconds = options?.leaseSeconds ?? LEASE_SECONDS;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      while (await runCivicImportWorkerOnce(workerId, leaseSeconds)) {
        // Drain the available queue.
      }
    } catch (error) {
      console.error(
        "[CivicImportWorker] polling failed:",
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  void tick();
  console.log(`[CivicImportWorker] started as ${workerId}`);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

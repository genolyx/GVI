import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  cases,
  curationRunEvents,
  curationRuns,
  variants,
  type CurationRun,
  type CurationRunInput,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { resolveEngineBuild } from "./liftover";
import { requireDb } from "./tenant";

/**
 * Lease-based queue for variant-level curation runs.
 *
 * Postgres `FOR UPDATE SKIP LOCKED` gives us a transactional queue with no separate
 * broker: concurrent workers never hand out the same run, and a claim is committed
 * in the same transaction that sets the lease.
 *
 * Every claim sets `leaseExpiresAt`. The engine takes minutes per variant and its
 * process can die mid-run, so without a lease a crashed worker would strand a run in
 * `running` forever — which is exactly what happens today in the older
 * `analysis_jobs` gateway claim path.
 */

/** Runs still occupying a queue slot for their variant. */
export const ACTIVE_CURATION_STATUSES = ["queued", "loading", "running"] as const;

/** A worker holds the lease in both of these. Loading is the reference-data mount. */
const LEASED_CURATION_STATUSES = ["loading", "running"] as const;

export type EnqueueCurationRun = {
  organizationId: number;
  caseId?: number | null;
  variantId?: number | null;
  input: CurationRunInput;
  priority?: number;
  requestedBy?: number | null;
  batchId?: number | null;
};

/**
 * The engine hardcodes `hg=38` in SpliceAI / Pangolin / Ensembl URLs. GRCh38 is
 * native. GRCh37 is accepted because gene + HGVS c. is transcript-relative and
 * genomic coordinates are lifted at enqueue. Anything else is rejected.
 */
export function assertCurationSupported(referenceBuild: string): void {
  if (referenceBuild !== "GRCh38" && referenceBuild !== "GRCh37") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Curation supports GRCh38 natively and GRCh37 via liftover. This case uses ${referenceBuild}.`,
    });
  }
}

export async function enqueueCurationRun(run: EnqueueCurationRun): Promise<{ id: number; deduped: boolean }> {
  assertCurationSupported(run.input.referenceBuild);
  const db = await requireDb();

  // `curation_runs_active_variant_uq` keeps a variant from being queued twice.
  // Treat a collision as success and return the run already in flight.
  if (run.variantId) {
    const existing = await db
      .select({ id: curationRuns.id })
      .from(curationRuns)
      .where(
        and(
          eq(curationRuns.organizationId, run.organizationId),
          eq(curationRuns.variantId, run.variantId),
          inArray(curationRuns.status, [...ACTIVE_CURATION_STATUSES])
        )
      )
      .limit(1);
    if (existing[0]) return { id: existing[0].id, deduped: true };
  }

  const inserted = await db
    .insert(curationRuns)
    .values({
      organizationId: run.organizationId,
      caseId: run.caseId ?? null,
      variantId: run.variantId ?? null,
      batchId: run.batchId ?? null,
      input: run.input,
      priority: run.priority ?? 0,
      requestedBy: run.requestedBy ?? null,
    })
    .returning({ id: curationRuns.id });

  const id = inserted[0].id;
  await db.insert(curationRunEvents).values({
    organizationId: run.organizationId,
    runId: id,
    status: "queued",
    message: `Queued curation for ${run.input.gene} ${run.input.hgvsC}.`,
    progressPercent: 0,
  });

  return { id, deduped: false };
}

/**
 * Lease the highest-priority queued run for a worker.
 *
 * Written as raw SQL because `FOR UPDATE SKIP LOCKED` inside an `UPDATE … WHERE id =
 * (SELECT …)` has no Drizzle query-builder equivalent, and the atomicity is the
 * whole point.
 */
export async function claimCurationRun(workerId: string): Promise<CurationRun | undefined> {
  const db = await requireDb();
  const result = await db.execute(sql`
    update curation_runs set
      status = 'loading',
      "workerId" = ${workerId},
      "leaseExpiresAt" = now() + ${`${ENV.engineLeaseSeconds} seconds`}::interval,
      "heartbeatAt" = now(),
      attempt = attempt + 1,
      "startedAt" = coalesce("startedAt", now())
    where id = (
      select id from curation_runs
      -- priority < 0 is a batch row waiting for Run batch; the worker must not claim it.
      where status = 'queued' and priority >= 0
      order by priority desc, "queuedAt" asc
      for update skip locked
      limit 1
    )
    returning *
  `);
  return (result.rows as CurationRun[])[0];
}

export async function extendCurationLease(
  runId: number,
  workerId: string
): Promise<Date | undefined> {
  const db = await requireDb();
  const rows = await db
    .update(curationRuns)
    .set({
      leaseExpiresAt: sql`now() + ${`${ENV.engineLeaseSeconds} seconds`}::interval`,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(curationRuns.id, runId),
        eq(curationRuns.workerId, workerId),
        inArray(curationRuns.status, [...LEASED_CURATION_STATUSES])
      )
    )
    .returning({ leaseExpiresAt: curationRuns.leaseExpiresAt });
  return rows[0]?.leaseExpiresAt ?? undefined;
}

/** A run the worker still owns, or undefined if the lease was already revoked. */
export async function getLeasedRun(
  runId: number,
  workerId: string
): Promise<CurationRun | undefined> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.id, runId),
        eq(curationRuns.workerId, workerId),
        inArray(curationRuns.status, [...LEASED_CURATION_STATUSES])
      )
    )
    .limit(1);
  return rows[0];
}

export type ReaperResult = { requeued: number[]; exhausted: number[] };

/**
 * Recover runs whose lease lapsed: requeue those with attempts left, and fail the
 * rest so they stop consuming a queue slot for their variant.
 */
export async function reapExpiredCurationLeases(): Promise<ReaperResult> {
  const db = await requireDb();

  const requeued = await db.execute(sql`
    update curation_runs set
      status = 'queued',
      "workerId" = null,
      "leaseExpiresAt" = null,
      "heartbeatAt" = null,
      "queuedAt" = now()
    where status in ('loading', 'running')
      and "leaseExpiresAt" < now()
      and attempt < "maxAttempts"
    returning id, "organizationId", attempt
  `);

  const exhausted = await db.execute(sql`
    update curation_runs set
      status = 'failed',
      "workerId" = null,
      "leaseExpiresAt" = null,
      "completedAt" = now(),
      error = jsonb_build_object(
        'kind', 'lease_expired',
        'message', 'Worker stopped reporting and the run exhausted its retries.',
        'attempt', attempt,
        'at', now()
      )
    where status in ('loading', 'running')
      and "leaseExpiresAt" < now()
      and attempt >= "maxAttempts"
    returning id, "organizationId", attempt
  `);

  type Reaped = { id: number; organizationId: number; attempt: number };
  const requeuedRows = requeued.rows as Reaped[];
  const exhaustedRows = exhausted.rows as Reaped[];

  const events = [
    ...requeuedRows.map(row => ({
      organizationId: row.organizationId,
      runId: row.id,
      status: "queued",
      message: `Lease expired on attempt ${row.attempt}; requeued.`,
      progressPercent: 0,
    })),
    ...exhaustedRows.map(row => ({
      organizationId: row.organizationId,
      runId: row.id,
      status: "failed",
      message: `Lease expired on attempt ${row.attempt}; no retries left.`,
      progressPercent: 0,
    })),
  ];
  if (events.length) {
    await db.insert(curationRunEvents).values(events);
  }

  return {
    requeued: requeuedRows.map(row => row.id),
    exhausted: exhaustedRows.map(row => row.id),
  };
}

/** Object-storage prefix for a run's artefacts, isolated per organization. */
export function curationStoragePrefix(organizationId: number, runId: number): string {
  return `organizations/${organizationId}/curation/runs/${runId}`;
}

/**
 * Resolve the engine input for a stored variant.
 *
 * The engine is driven by gene + HGVS c., not by coordinates, so a variant without
 * those annotations cannot be curated.
 */
export async function buildCurationInputForVariant(
  organizationId: number,
  variantId: number,
  options: { runLiterature?: boolean } = {}
): Promise<{ input: CurationRunInput; caseId: number }> {
  const db = await requireDb();
  const rows = await db
    .select({
      gene: variants.gene,
      hgvsC: variants.hgvsC,
      hgvsP: variants.hgvsP,
      transcript: variants.transcript,
      referenceBuild: variants.referenceBuild,
      chromosome: variants.chromosome,
      position: variants.position,
      annotation: variants.annotation,
      caseId: variants.caseId,
      indication: cases.indication,
      phenotypeText: cases.phenotypeText,
    })
    .from(variants)
    .innerJoin(
      cases,
      and(eq(cases.id, variants.caseId), eq(cases.organizationId, variants.organizationId))
    )
    .where(and(eq(variants.organizationId, organizationId), eq(variants.id, variantId)))
    .limit(1);

  const variant = rows[0];
  if (!variant) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
  }
  if (!variant.gene || !variant.hgvsC) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Curation needs a gene symbol and HGVSc on the variant.",
    });
  }
  assertCurationSupported(variant.referenceBuild);

  const resolved = await resolveEngineBuild({
    referenceBuild: variant.referenceBuild,
    chromosome: variant.chromosome,
    position: variant.position,
  });

  if (resolved.liftedLocus || resolved.liftError) {
    const existing =
      variant.annotation && typeof variant.annotation === "object" ? variant.annotation : {};
    await db
      .update(variants)
      .set({
        annotation: {
          ...existing,
          lifted: resolved.liftedLocus,
          liftError: resolved.liftError,
        },
      })
      .where(and(eq(variants.organizationId, organizationId), eq(variants.id, variantId)));
  }

  return {
    caseId: variant.caseId,
    input: {
      gene: variant.gene,
      hgvsC: variant.hgvsC,
      hgvsP: variant.hgvsP,
      transcript: variant.transcript,
      clinicalNotes: [variant.indication, variant.phenotypeText].filter(Boolean).join("\n") || null,
      referenceBuild: resolved.referenceBuild,
      submittedBuild: resolved.submittedBuild,
      liftedLocus: resolved.liftedLocus,
      liftError: resolved.liftError,
      runLiterature: options.runLiterature ?? true,
    },
  };
}

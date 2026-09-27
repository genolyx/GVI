import { and, eq, sql } from "drizzle-orm";
import {
  somaticClinicalAssertions,
  somaticEvidenceRecords,
  somaticInterpretationRuns,
  somaticVariantAnalyses,
} from "../../../drizzle/schema";
import { requireDb } from "../tenant";
import { createOrganizationSomaticEvidenceProvider } from "./offlineKnowledge";
import { addSomaticRunEvent, processSomaticRun } from "./runProcessor";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const DEFAULT_LEASE_SECONDS = positiveIntegerEnv(
  "SOMATIC_WORKER_LEASE_SECONDS",
  300
);
const DEFAULT_POLL_MS = positiveIntegerEnv("SOMATIC_WORKER_POLL_MS", 2_000);

type ClaimedRun = {
  id: number;
  organizationId: number;
  caseId: number;
  attemptCount: number;
  maxAttempts: number;
};

export function somaticRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

async function claimSomaticRun(
  workerId: string,
  leaseSeconds: number
): Promise<ClaimedRun | null> {
  const db = await requireDb();
  const result = await db.execute<ClaimedRun>(sql`
    WITH candidate AS (
      SELECT id
      FROM somatic_interpretation_runs
      WHERE "attemptCount" < "maxAttempts"
        AND (
          (
            status = 'queued'
            AND "availableAt" <= now()
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= now())
          )
          OR (
            status IN ('validating', 'normalizing', 'annotating')
            AND "leaseExpiresAt" IS NOT NULL
            AND "leaseExpiresAt" <= now()
          )
        )
      ORDER BY "availableAt" ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE somatic_interpretation_runs AS run
    SET status = 'queued',
        "attemptCount" = run."attemptCount" + 1,
        "leaseOwner" = ${workerId},
        "leaseExpiresAt" = now() + (${leaseSeconds} * interval '1 second'),
        "lastError" = NULL,
        "completedAt" = NULL,
        "updatedAt" = now()
    FROM candidate
    WHERE run.id = candidate.id
    RETURNING
      run.id,
      run."organizationId",
      run."caseId",
      run."attemptCount",
      run."maxAttempts"
  `);
  return result.rows[0] ?? null;
}

async function resetRunArtifacts(run: ClaimedRun) {
  const db = await requireDb();
  await db.transaction(async tx => {
    await tx
      .delete(somaticClinicalAssertions)
      .where(
        and(
          eq(somaticClinicalAssertions.organizationId, run.organizationId),
          eq(somaticClinicalAssertions.runId, run.id)
        )
      );
    await tx
      .delete(somaticEvidenceRecords)
      .where(
        and(
          eq(somaticEvidenceRecords.organizationId, run.organizationId),
          eq(somaticEvidenceRecords.runId, run.id)
        )
      );
    await tx
      .delete(somaticVariantAnalyses)
      .where(
        and(
          eq(somaticVariantAnalyses.organizationId, run.organizationId),
          eq(somaticVariantAnalyses.runId, run.id)
        )
      );
  });
}

async function extendLease(
  run: ClaimedRun,
  workerId: string,
  leaseSeconds: number
) {
  const db = await requireDb();
  await db
    .update(somaticInterpretationRuns)
    .set({
      leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
    })
    .where(
      and(
        eq(somaticInterpretationRuns.id, run.id),
        eq(somaticInterpretationRuns.organizationId, run.organizationId),
        eq(somaticInterpretationRuns.leaseOwner, workerId)
      )
    );
}

async function finishLease(run: ClaimedRun, workerId: string) {
  const db = await requireDb();
  await db
    .update(somaticInterpretationRuns)
    .set({ leaseOwner: null, leaseExpiresAt: null, lastError: null })
    .where(
      and(
        eq(somaticInterpretationRuns.id, run.id),
        eq(somaticInterpretationRuns.organizationId, run.organizationId),
        eq(somaticInterpretationRuns.leaseOwner, workerId)
      )
    );
}

async function retryOrFinalize(
  run: ClaimedRun,
  workerId: string,
  message: string
) {
  const db = await requireDb();
  if (run.attemptCount < run.maxAttempts) {
    const delayMs = somaticRetryDelayMs(run.attemptCount);
    await db
      .update(somaticInterpretationRuns)
      .set({
        status: "queued",
        availableAt: new Date(Date.now() + delayMs),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: message,
        error: {
          message,
          retryScheduled: true,
          attemptCount: run.attemptCount,
          maxAttempts: run.maxAttempts,
        },
        completedAt: null,
      })
      .where(
        and(
          eq(somaticInterpretationRuns.id, run.id),
          eq(somaticInterpretationRuns.organizationId, run.organizationId),
          eq(somaticInterpretationRuns.leaseOwner, workerId)
        )
      );
    await addSomaticRunEvent(
      run.organizationId,
      run.id,
      "queued",
      `Somatic interpretation retry ${run.attemptCount + 1}/${run.maxAttempts} scheduled.`,
      0,
      { previousError: message, retryDelayMs: delayMs }
    );
    return;
  }
  await db
    .update(somaticInterpretationRuns)
    .set({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: message,
      error: {
        message,
        retryScheduled: false,
        attemptCount: run.attemptCount,
        maxAttempts: run.maxAttempts,
      },
      completedAt: new Date(),
    })
    .where(
      and(
        eq(somaticInterpretationRuns.id, run.id),
        eq(somaticInterpretationRuns.organizationId, run.organizationId),
        eq(somaticInterpretationRuns.leaseOwner, workerId)
      )
    );
}

export async function runSomaticWorkerOnce(
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<boolean> {
  const run = await claimSomaticRun(workerId, leaseSeconds);
  if (!run) return false;
  const heartbeat = setInterval(
    () => void extendLease(run, workerId, leaseSeconds),
    Math.max(1_000, Math.floor((leaseSeconds * 1000) / 3))
  );
  heartbeat.unref?.();
  try {
    await resetRunArtifacts(run);
    const evidenceProvider =
      await createOrganizationSomaticEvidenceProvider(run.organizationId);
    const result = await processSomaticRun({
      organizationId: run.organizationId,
      runId: run.id,
      caseId: run.caseId,
      evidenceProvider,
    });
    if (result.success) {
      await finishLease(run, workerId);
    } else {
      await retryOrFinalize(run, workerId, result.message);
    }
  } catch (error) {
    await retryOrFinalize(
      run,
      workerId,
      error instanceof Error ? error.message : "Somatic worker failed."
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function startSomaticWorker(options?: {
  workerId?: string;
  pollMs?: number;
  leaseSeconds?: number;
}) {
  const workerId =
    options?.workerId ??
    `somatic-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const leaseSeconds = options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      while (await runSomaticWorkerOnce(workerId, leaseSeconds)) {
        // Drain currently available jobs before returning to the poll timer.
      }
    } catch (error) {
      console.error(
        "[SomaticWorker] polling failed:",
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  void tick();
  console.log(`[SomaticWorker] started as ${workerId}`);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

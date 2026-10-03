import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { cases, curationBatches, curationRuns, variants } from "../../drizzle/schema";
import { ACTIVE_CURATION_STATUSES, buildCurationInputForVariant, enqueueCurationRun } from "./curationQueue";
import {
  findStoredClassification,
  recordReusedClassification,
  reuseQueuedClassifications,
} from "./curationReuse";
import { ensureCurationWorker } from "./curationWorker";
import { requireDb } from "./tenant";

/** Automatic classification after filtering. The engine runs one variant at a time. */
export const CASE_CLASSIFIER_LIMIT = 200;
const BULK_PRIORITY = 10;

export type CaseClassifierSkip = { variantId: number; reason: string };

export type CaseClassifierQueue = {
  queued: number;
  reused: number;
  skipped: CaseClassifierSkip[];
  worker: "started" | "already_running" | "unavailable" | "not_needed";
  workerError: string | null;
};

/** Batch name for one germline VCF case. The case id keeps it unique in the org. */
export function caseCurationBatchName(caseNumber: string, caseId: number): string {
  const name = `Case ${caseNumber} (#${caseId})`;
  return name.length <= 160 ? name : `${name.slice(0, 157)}...`;
}

/**
 * One workbench batch per germline case, so each classified variant has a review page.
 *
 * Runs already stored for the case and not in another batch are attached. A case that
 * has not been classified yet does not get an empty batch.
 */
export async function ensureCaseCurationBatch(args: {
  organizationId: number;
  caseId: number;
  createdBy: number | null;
}): Promise<number | null> {
  const db = await requireDb();
  const [row] = await db
    .select({ caseNumber: cases.caseNumber, purpose: cases.purpose })
    .from(cases)
    .where(and(eq(cases.organizationId, args.organizationId), eq(cases.id, args.caseId)))
    .limit(1);
  if (!row || row.purpose !== "germline") return null;

  const name = caseCurationBatchName(row.caseNumber, args.caseId);
  const existing = await db
    .select({ id: curationBatches.id })
    .from(curationBatches)
    .where(and(eq(curationBatches.organizationId, args.organizationId), eq(curationBatches.name, name)))
    .limit(1);
  let batchId = existing[0]?.id;
  if (!batchId) {
    try {
      const inserted = await db
        .insert(curationBatches)
        .values({
          organizationId: args.organizationId,
          name,
          createdBy: args.createdBy,
        })
        .returning({ id: curationBatches.id });
      batchId = inserted[0]?.id;
    } catch {
      const again = await db
        .select({ id: curationBatches.id })
        .from(curationBatches)
        .where(and(eq(curationBatches.organizationId, args.organizationId), eq(curationBatches.name, name)))
        .limit(1);
      batchId = again[0]?.id;
    }
  }
  if (!batchId) return null;

  await db
    .update(curationRuns)
    .set({ batchId })
    .where(
      and(
        eq(curationRuns.organizationId, args.organizationId),
        eq(curationRuns.caseId, args.caseId),
        isNull(curationRuns.batchId)
      )
    );
  return batchId;
}

export function classifierQueueMessage(result: CaseClassifierQueue): string {
  const reused = result.reused
    ? ` Reused ${result.reused} stored classification(s) without calling the engine.`
    : "";
  if (result.queued === 0) {
    const classified = result.skipped.filter(item => item.reason === "Already classified").length;
    if (classified > 0 && classified === result.skipped.length) {
      return "Variant classifier already finished for these variants.";
    }
    const skipped = result.skipped.length
      ? ` ${result.skipped.length} variant(s) were skipped.`
      : "";
    return `Variant classifier was not queued.${reused}${skipped}`;
  }
  const skipped = result.skipped.length ? ` ${result.skipped.length} variant(s) were skipped.` : "";
  const worker =
    result.worker === "started"
      ? " Classifier worker started."
      : result.worker === "already_running"
        ? " Classifier worker is already running."
        : result.workerError
          ? ` Classifier worker did not start: ${result.workerError}`
          : "";
  return `Variant classifier queued for ${result.queued} variant(s).${reused}${skipped}${worker}`;
}

/**
 * Queue the filtered variants of one germline case for SAM-VC.
 *
 * Variants that already have an active or succeeded run are left alone. Literature
 * stays off so a filtered list can move through the queue without a paper search
 * on every row.
 */
export async function enqueueFilteredCaseVariants(args: {
  organizationId: number;
  caseId: number;
  requestedBy: number | null;
}): Promise<CaseClassifierQueue> {
  const db = await requireDb();
  const reusedQueued = await reuseQueuedClassifications(args.organizationId, args.caseId);
  const rows = await db
    .select({ id: variants.id, gene: variants.gene, hgvsC: variants.hgvsC })
    .from(variants)
    .where(
      and(
        eq(variants.organizationId, args.organizationId),
        eq(variants.caseId, args.caseId),
        isNull(variants.heldReason)
      )
    )
    .orderBy(desc(variants.triageScore), variants.id);

  const existing = await db
    .select({ variantId: curationRuns.variantId, status: curationRuns.status })
    .from(curationRuns)
    .where(
      and(eq(curationRuns.organizationId, args.organizationId), eq(curationRuns.caseId, args.caseId))
    );

  const classified = new Set<number>();
  const active = new Set<number>();
  for (const run of existing) {
    if (!run.variantId) continue;
    if (run.status === "succeeded") classified.add(run.variantId);
    else if ((ACTIVE_CURATION_STATUSES as readonly string[]).includes(run.status)) {
      active.add(run.variantId);
    }
  }

  const skipped: CaseClassifierSkip[] = [];
  const eligible: number[] = [];
  for (const row of rows) {
    if (!row.gene || !row.hgvsC) {
      skipped.push({ variantId: row.id, reason: "Needs a gene symbol and HGVSc" });
      continue;
    }
    if (classified.has(row.id)) {
      skipped.push({ variantId: row.id, reason: "Already classified" });
      continue;
    }
    if (active.has(row.id)) {
      skipped.push({ variantId: row.id, reason: "Already queued or running" });
      continue;
    }
    eligible.push(row.id);
  }
  const overflow = eligible.slice(CASE_CLASSIFIER_LIMIT);
  for (const variantId of overflow) {
    skipped.push({ variantId, reason: `Classifier queue holds ${CASE_CLASSIFIER_LIMIT} variants per case` });
  }

  const batchId =
    eligible.length || classified.size || active.size
      ? await ensureCaseCurationBatch({
          organizationId: args.organizationId,
          caseId: args.caseId,
          createdBy: args.requestedBy,
        })
      : null;

  let queued = 0;
  let reused = reusedQueued;
  for (const variantId of eligible.slice(0, CASE_CLASSIFIER_LIMIT)) {
    try {
      const built = await buildCurationInputForVariant(args.organizationId, variantId, {
        runLiterature: false,
      });
      const stored = await findStoredClassification(
        args.organizationId,
        built.input.gene,
        built.input.hgvsC
      );
      if (stored) {
        await recordReusedClassification({
          organizationId: args.organizationId,
          caseId: built.caseId,
          variantId,
          batchId,
          requestedBy: args.requestedBy,
          input: built.input,
          stored,
        });
        reused += 1;
        continue;
      }
      const result = await enqueueCurationRun({
        organizationId: args.organizationId,
        caseId: built.caseId,
        variantId,
        batchId,
        input: built.input,
        priority: BULK_PRIORITY,
        requestedBy: args.requestedBy,
      });
      if (result.deduped) skipped.push({ variantId, reason: "Already queued or running" });
      else queued += 1;
    } catch (error) {
      skipped.push({
        variantId,
        reason: error instanceof TRPCError ? error.message : "Could not queue",
      });
    }
  }

  if (queued === 0) {
    return { queued, reused, skipped, worker: "not_needed", workerError: null };
  }

  try {
    const worker = ensureCurationWorker();
    return {
      queued,
      reused,
      skipped,
      worker: worker.alreadyRunning ? "already_running" : "started",
      workerError: null,
    };
  } catch (error) {
    return {
      queued,
      reused,
      skipped,
      worker: "unavailable",
      workerError: error instanceof Error ? error.message : "Could not start the classifier",
    };
  }
}

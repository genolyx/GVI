import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { curationRuns, variants } from "../../drizzle/schema";
import { ACTIVE_CURATION_STATUSES, buildCurationInputForVariant, enqueueCurationRun } from "./curationQueue";
import { ensureCurationWorker } from "./curationWorker";
import { requireDb } from "./tenant";

/** Automatic classification after filtering. The engine runs one variant at a time. */
export const CASE_CLASSIFIER_LIMIT = 200;
const BULK_PRIORITY = 10;

export type CaseClassifierSkip = { variantId: number; reason: string };

export type CaseClassifierQueue = {
  queued: number;
  skipped: CaseClassifierSkip[];
  worker: "started" | "already_running" | "unavailable" | "not_needed";
  workerError: string | null;
};

export function classifierQueueMessage(result: CaseClassifierQueue): string {
  if (result.queued === 0) {
    const classified = result.skipped.filter(item => item.reason === "Already classified").length;
    if (classified > 0 && classified === result.skipped.length) {
      return "Variant classifier already finished for these variants.";
    }
    const skipped = result.skipped.length
      ? ` ${result.skipped.length} variant(s) were skipped.`
      : "";
    return `Variant classifier was not queued.${skipped}`;
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
  return `Variant classifier queued for ${result.queued} variant(s).${skipped}${worker}`;
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
  const rows = await db
    .select({ id: variants.id, gene: variants.gene, hgvsC: variants.hgvsC })
    .from(variants)
    .where(and(eq(variants.organizationId, args.organizationId), eq(variants.caseId, args.caseId)))
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

  let queued = 0;
  for (const variantId of eligible.slice(0, CASE_CLASSIFIER_LIMIT)) {
    try {
      const built = await buildCurationInputForVariant(args.organizationId, variantId, {
        runLiterature: false,
      });
      const result = await enqueueCurationRun({
        organizationId: args.organizationId,
        caseId: built.caseId,
        variantId,
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
    return { queued, skipped, worker: "not_needed", workerError: null };
  }

  try {
    const worker = ensureCurationWorker();
    return {
      queued,
      skipped,
      worker: worker.alreadyRunning ? "already_running" : "started",
      workerError: null,
    };
  } catch (error) {
    return {
      queued,
      skipped,
      worker: "unavailable",
      workerError: error instanceof Error ? error.message : "Could not start the classifier",
    };
  }
}

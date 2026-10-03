import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  curationRunEvents,
  curationRuns,
  type CurationRun,
  type CurationRunInput,
} from "../../drizzle/schema";
import { curationDocumentSchema, type CurationSummary } from "../../shared/curation/document";
import { mergeCurationDocument } from "./curationMerge";
import { requireDb } from "./tenant";
import { storageGetText } from "../storage";

export type StoredClassification = {
  id: number;
  documentKey: string;
  documentHash: string | null;
  rawKey: string | null;
  rawHash: string | null;
  summary: CurationSummary | null;
  engineVersion: string | null;
  contractVersion: string | null;
  timings: Record<string, number> | null;
  attempt: number;
  startedAt: Date | null;
  completedAt: Date | null;
};

/** Latest succeeded classification of this gene and HGVSc in the organization. */
export async function findStoredClassification(
  organizationId: number,
  gene: string,
  hgvsC: string,
  exceptRunId?: number
): Promise<StoredClassification | null> {
  const db = await requireDb();
  const rows = await db
    .select({
      id: curationRuns.id,
      documentKey: curationRuns.documentKey,
      documentHash: curationRuns.documentHash,
      rawKey: curationRuns.rawKey,
      rawHash: curationRuns.rawHash,
      summary: curationRuns.summary,
      engineVersion: curationRuns.engineVersion,
      contractVersion: curationRuns.contractVersion,
      timings: curationRuns.timings,
      attempt: curationRuns.attempt,
      startedAt: curationRuns.startedAt,
      completedAt: curationRuns.completedAt,
    })
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.organizationId, organizationId),
        eq(curationRuns.status, "succeeded"),
        sql`${curationRuns.documentKey} is not null`,
        sql`lower(${curationRuns.input}->>'gene') = ${gene.trim().toLowerCase()}`,
        sql`lower(${curationRuns.input}->>'hgvsC') = ${hgvsC.trim().toLowerCase()}`,
        ...(exceptRunId ? [ne(curationRuns.id, exceptRunId)] : [])
      )
    )
    .orderBy(desc(curationRuns.completedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.documentKey) return null;
  return { ...row, documentKey: row.documentKey };
}

async function mergeStoredDocument(
  run: Pick<CurationRun, "id" | "organizationId" | "variantId" | "requestedBy">,
  documentKey: string
) {
  const db = await requireDb();
  try {
    const parsed = curationDocumentSchema.safeParse(JSON.parse(await storageGetText(documentKey)));
    if (!parsed.success || !run.variantId) {
      await db.insert(curationRunEvents).values({
        organizationId: run.organizationId,
        runId: run.id,
        status: "merge_failed",
        message: "Stored classification was reused, but its document could not be applied to the variant.",
        progressPercent: 100,
      });
      return;
    }
    const merge = await mergeCurationDocument(run, parsed.data);
    if (!merge) return;
    await db.insert(curationRunEvents).values({
      organizationId: run.organizationId,
      runId: run.id,
      status: "merged",
      message: `Reused stored classification. Merged ${merge.criteriaWritten} criteria into interpretation ${merge.interpretationId}.`,
      progressPercent: 100,
    });
  } catch (error) {
    console.error(`[Curation] Reused document merge failed for run ${run.id}:`, error);
    await db.insert(curationRunEvents).values({
      organizationId: run.organizationId,
      runId: run.id,
      status: "merge_failed",
      message: "Stored classification was reused, but its document could not be applied to the variant.",
      progressPercent: 100,
    });
  }
}

/** Attach a finished classification to this variant and skip the engine. */
export async function recordReusedClassification(args: {
  organizationId: number;
  caseId: number;
  variantId: number;
  batchId: number | null;
  requestedBy: number | null;
  input: CurationRunInput;
  stored: StoredClassification;
}): Promise<number> {
  const db = await requireDb();
  const inserted = await db
    .insert(curationRuns)
    .values({
      organizationId: args.organizationId,
      caseId: args.caseId,
      variantId: args.variantId,
      batchId: args.batchId,
      input: args.input,
      status: "succeeded",
      priority: 0,
      requestedBy: args.requestedBy,
      documentKey: args.stored.documentKey,
      documentHash: args.stored.documentHash,
      rawKey: args.stored.rawKey,
      rawHash: args.stored.rawHash,
      summary: args.stored.summary,
      engineVersion: args.stored.engineVersion,
      contractVersion: args.stored.contractVersion,
      timings: args.stored.timings,
      attempt: args.stored.attempt,
      startedAt: args.stored.startedAt,
      completedAt: args.stored.completedAt ?? new Date(),
    })
    .returning({ id: curationRuns.id });
  const id = inserted[0]!.id;
  await db.insert(curationRunEvents).values({
    organizationId: args.organizationId,
    runId: id,
    status: "succeeded",
    message: `Reused the stored classification from run ${args.stored.id}.`,
    progressPercent: 100,
  });
  await mergeStoredDocument(
    {
      id,
      organizationId: args.organizationId,
      variantId: args.variantId,
      requestedBy: args.requestedBy,
    },
    args.stored.documentKey
  );
  return id;
}

/** Copy a finished classification onto a queued run so the engine is not called again. */
export async function reuseQueuedClassifications(
  organizationId: number,
  caseId: number
): Promise<number> {
  const db = await requireDb();
  const queued = await db
    .select({
      id: curationRuns.id,
      variantId: curationRuns.variantId,
      requestedBy: curationRuns.requestedBy,
      input: curationRuns.input,
    })
    .from(curationRuns)
    .where(
      and(
        eq(curationRuns.organizationId, organizationId),
        eq(curationRuns.caseId, caseId),
        eq(curationRuns.status, "queued")
      )
    );
  let reused = 0;
  for (const run of queued) {
    const stored = await findStoredClassification(
      organizationId,
      run.input.gene,
      run.input.hgvsC,
      run.id
    );
    if (!stored) continue;
    const updated = await db
      .update(curationRuns)
      .set({
        status: "succeeded",
        documentKey: stored.documentKey,
        documentHash: stored.documentHash,
        rawKey: stored.rawKey,
        rawHash: stored.rawHash,
        summary: stored.summary,
        engineVersion: stored.engineVersion,
        contractVersion: stored.contractVersion,
        timings: stored.timings,
        attempt: stored.attempt,
        startedAt: stored.startedAt,
        completedAt: stored.completedAt ?? new Date(),
        error: null,
        leaseExpiresAt: null,
        workerId: null,
      })
      .where(
        and(
          eq(curationRuns.id, run.id),
          eq(curationRuns.organizationId, organizationId),
          eq(curationRuns.status, "queued")
        )
      )
      .returning({ id: curationRuns.id });
    if (!updated.length) continue;
    reused += 1;
    await db.insert(curationRunEvents).values({
      organizationId,
      runId: run.id,
      status: "succeeded",
      message: `Reused the stored classification from run ${stored.id}.`,
      progressPercent: 100,
    });
    await mergeStoredDocument(
      {
        id: run.id,
        organizationId,
        variantId: run.variantId,
        requestedBy: run.requestedBy,
      },
      stored.documentKey
    );
  }
  return reused;
}

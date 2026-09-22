import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cases, variants } from "../../drizzle/schema";
import { requireDb } from "./tenant";
import { parsePanelGenes, triageVariant, type TriageTier } from "./triage";

/**
 * Run the triage rules over a whole case.
 *
 * Batched rather than streamed: a 50,000-variant case is a few megabytes of the
 * narrow column set the rules read, and one pass per batch keeps the update count
 * bounded. The pass is idempotent, so re-running after new annotation arrives
 * simply recomputes the tiers.
 */

const BATCH_SIZE = 2000;

export type TriagePassResult = {
  caseId: number;
  scanned: number;
  counts: Record<TriageTier, number>;
};

export async function runTriagePass(
  organizationId: number,
  caseId: number,
  options: { onlyUntriaged?: boolean } = {}
): Promise<TriagePassResult> {
  const db = await requireDb();

  const caseRows = await db
    .select({ panelName: cases.panelName })
    .from(cases)
    .where(and(eq(cases.organizationId, organizationId), eq(cases.id, caseId)))
    .limit(1);
  if (!caseRows[0]) throw new Error(`Case ${caseId} not found in organization ${organizationId}`);

  const panelGenes = parsePanelGenes(caseRows[0].panelName);
  const counts: Record<TriageTier, number> = { t1_curate: 0, t2_review: 0, t3_filtered: 0 };
  let scanned = 0;
  let cursor = 0;

  for (;;) {
    const batch = await db
      .select({
        id: variants.id,
        gene: variants.gene,
        consequence: variants.consequence,
        impact: variants.impact,
        populationAf: variants.populationAf,
        clinvarSignificance: variants.clinvarSignificance,
        hgvsC: variants.hgvsC,
        referenceBuild: variants.referenceBuild,
      })
      .from(variants)
      .where(
        and(
          eq(variants.organizationId, organizationId),
          eq(variants.caseId, caseId),
          sql`${variants.id} > ${cursor}`,
          ...(options.onlyUntriaged ? [isNull(variants.triageTier)] : [])
        )
      )
      .orderBy(variants.id)
      .limit(BATCH_SIZE);

    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    // Group rows by verdict so each distinct outcome is a single UPDATE rather than
    // one statement per variant.
    const byVerdict = new Map<string, { ids: number[]; tier: TriageTier; score: number; reasons: string[] }>();
    for (const row of batch) {
      const verdict = triageVariant(row, { panelGenes });
      counts[verdict.tier] += 1;
      const key = `${verdict.tier}|${verdict.score}|${verdict.reasons.join("\u0000")}`;
      const bucket = byVerdict.get(key);
      if (bucket) bucket.ids.push(row.id);
      else byVerdict.set(key, { ids: [row.id], ...verdict });
    }

    for (const bucket of Array.from(byVerdict.values())) {
      await db
        .update(variants)
        .set({
          triageTier: bucket.tier,
          triageScore: bucket.score,
          triageReasons: bucket.reasons,
          triagedAt: new Date(),
        })
        .where(
          and(eq(variants.organizationId, organizationId), inArray(variants.id, bucket.ids))
        );
    }
  }

  return { caseId, scanned, counts };
}

import { and, eq, inArray } from "drizzle-orm";
import {
  criteriaAssessments,
  evidenceItems,
  interpretations,
  variants,
  type CurationRun,
} from "../../drizzle/schema";
import { ACMG_CRITERIA } from "../../shared/clinical-standards";
import {
  ENGINE_HTML_KEYS,
  type CurationDocument,
} from "../../shared/curation/document";
import { requireDb } from "./tenant";

/**
 * Fold a successful curation run into the variant's interpretation.
 *
 * The engine advises; it never signs. Everything written here lands on a `draft`
 * interpretation with `origin = 'engine'`, so a reviewer still has to accept each
 * criterion and approve the interpretation. There is deliberately no path by which
 * the engine can produce an `approved` classification.
 *
 * Re-running is idempotent: rows a previous run wrote are replaced, while rows a
 * person entered or confirmed are left alone. That way a reviewer's work survives
 * a re-curation with a newer engine build.
 */

/** Engine source names mapped onto `evidence_source`. */
const EVIDENCE_SOURCE_BY_KEY = {
  clinvar_sig: "ClinVar",
  hgmd_local: "HGMD",
  clingen_haplo_score: "ClinGen",
  spliceai_narrative: "SpliceAI",
  pangolin_ds_sg: "Pangolin",
  critical_domain_names: "UniProt",
  ensembl_transcript_id: "Ensembl",
} as const;

type MergeResult = {
  interpretationId: number;
  criteriaWritten: number;
  criteriaSkipped: number;
  evidenceWritten: number;
};

function isAcmgCode(code: string): boolean {
  return (ACMG_CRITERIA as readonly string[]).includes(code);
}

/** Short, plain-text excerpt for an evidence row, with engine markup removed. */
function excerptFor(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if ((ENGINE_HTML_KEYS as readonly string[]).includes(key)) {
    text = text.replace(/<[^>]*>/g, " ");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

/**
 * Build the evidence rows implied by the engine's findings.
 *
 * Only facts a reviewer would cite become rows. The full engine document stays in
 * object storage, so this is a curated index into it rather than a copy.
 */
function engineEvidence(document: CurationDocument) {
  const parsed = document.engine.parsedData;
  const rows: {
    source: (typeof EVIDENCE_SOURCE_BY_KEY)[keyof typeof EVIDENCE_SOURCE_BY_KEY];
    title: string;
    excerpt: string;
    url: string | null;
    direction: "supporting" | "contradicting" | "neutral";
    payload: Record<string, unknown>;
  }[] = [];

  for (const [key, source] of Object.entries(EVIDENCE_SOURCE_BY_KEY)) {
    const excerpt = excerptFor(key, parsed[key]);
    if (!excerpt) continue;
    const urlKey = {
      ClinVar: "clinvar_search_link",
      HGMD: "hgmd_link",
      ClinGen: "clingen_link",
      UniProt: "uniprot_link",
      SpliceAI: null,
      Pangolin: null,
      Ensembl: null,
    }[source];
    rows.push({
      source,
      title: `${source}: ${document.variant.gene} ${document.variant.hgvsC}`,
      excerpt,
      url: urlKey ? ((parsed[urlKey] as string) || null) : null,
      direction: "neutral",
      payload: { engineKey: key },
    });
  }

  return rows;
}

export async function mergeCurationDocument(
  run: Pick<CurationRun, "id" | "organizationId" | "variantId" | "requestedBy">,
  document: CurationDocument
): Promise<MergeResult | null> {
  // Ad-hoc runs have no stored variant, so there is no interpretation to attach to.
  if (!run.variantId) return null;

  const db = await requireDb();
  const variantId = run.variantId;

  return db.transaction(async tx => {
    const variantRows = await tx
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.organizationId, run.organizationId), eq(variants.id, variantId)))
      .limit(1);
    if (!variantRows[0]) return null;

    // Reuse the open draft if one exists; otherwise start a new version so an
    // approved interpretation is never mutated underneath a signed report.
    const existing = await tx
      .select()
      .from(interpretations)
      .where(
        and(
          eq(interpretations.organizationId, run.organizationId),
          eq(interpretations.variantId, variantId)
        )
      )
      .orderBy(interpretations.version)
      .then(rows => rows.at(-1) ?? null);

    let interpretationId: number;
    const rationale = `Engine ${document.meta.engineVersion} suggests ${
      document.acmg.classification?.label ?? "no classification"
    } from ${document.acmg.criteria.length} criteria. Review required.`;

    if (existing && existing.status !== "approved") {
      interpretationId = existing.id;
      await tx
        .update(interpretations)
        .set({ rationale })
        .where(
          and(
            eq(interpretations.id, existing.id),
            eq(interpretations.organizationId, run.organizationId)
          )
        );
    } else {
      const inserted = await tx
        .insert(interpretations)
        .values({
          organizationId: run.organizationId,
          variantId,
          mode: "germline",
          rationale,
          status: "draft",
          version: (existing?.version ?? 0) + 1,
          origin: "engine",
          // Null unless a person asked for this run. See the column comment.
          createdBy: run.requestedBy ?? null,
        })
        .returning({ id: interpretations.id });
      interpretationId = inserted[0].id;
    }

    // Drop what an earlier run of this variant wrote, but never a human's row.
    await tx
      .delete(criteriaAssessments)
      .where(
        and(
          eq(criteriaAssessments.organizationId, run.organizationId),
          eq(criteriaAssessments.interpretationId, interpretationId),
          eq(criteriaAssessments.origin, "engine")
        )
      );
    await tx
      .delete(evidenceItems)
      .where(
        and(
          eq(evidenceItems.organizationId, run.organizationId),
          eq(evidenceItems.variantId, variantId),
          eq(evidenceItems.origin, "engine")
        )
      );

    const evidenceRows = engineEvidence(document);
    const insertedEvidence = evidenceRows.length
      ? await tx
          .insert(evidenceItems)
          .values(
            evidenceRows.map(row => ({
              organizationId: run.organizationId,
              variantId,
              source: row.source,
              clinicalDomain: "germline_classification" as const,
              title: row.title,
              url: row.url,
              excerpt: row.excerpt,
              direction: row.direction,
              payload: row.payload,
              origin: "engine" as const,
              curationRunId: run.id,
              createdBy: null,
            }))
          )
          .returning({ id: evidenceItems.id })
      : [];
    const evidenceIds = insertedEvidence.map(row => row.id);

    // Criteria a reviewer already decided on keep their decision; the engine only
    // fills gaps.
    const humanCodes = new Set(
      (
        await tx
          .select({ code: criteriaAssessments.code })
          .from(criteriaAssessments)
          .where(
            and(
              eq(criteriaAssessments.organizationId, run.organizationId),
              eq(criteriaAssessments.interpretationId, interpretationId)
            )
          )
      ).map(row => row.code)
    );

    let criteriaWritten = 0;
    let criteriaSkipped = 0;
    for (const criterion of document.acmg.criteria) {
      // `criteria_assessments.code` is keyed on bare ACMG codes; the engine's
      // strength suffix moves into strengthOverride.
      if (!isAcmgCode(criterion.baseCode) || humanCodes.has(criterion.baseCode)) {
        criteriaSkipped += 1;
        continue;
      }
      await tx.insert(criteriaAssessments).values({
        organizationId: run.organizationId,
        interpretationId,
        code: criterion.baseCode,
        state: "met",
        strengthOverride: criterion.strength,
        evidenceIds,
        note: criterion.rationale || null,
        origin: "engine",
        curationRunId: run.id,
        updatedBy: null,
      });
      criteriaWritten += 1;
    }

    return {
      interpretationId,
      criteriaWritten,
      criteriaSkipped,
      evidenceWritten: evidenceIds.length,
    };
  });
}

/** Evidence rows a run wrote, for display next to the engine's criteria. */
export async function engineEvidenceForRun(organizationId: number, runIds: readonly number[]) {
  if (!runIds.length) return [];
  const db = await requireDb();
  return db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.organizationId, organizationId),
        inArray(evidenceItems.curationRunId, [...runIds])
      )
    );
}

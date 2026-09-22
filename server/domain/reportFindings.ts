import type { CurationSummary } from "../../shared/curation/document";

/**
 * Turn a reviewer classification plus the latest engine summary into one findings
 * paragraph for a report draft.
 *
 * The engine advises; the reviewer signs. The first line is always the human
 * classification so a signed report cannot be read as "the engine decided". The
 * engine line is labelled as a suggestion and names the document hash so the
 * signed snapshot can prove which engine output was in front of the signer.
 */

export type ReportVariantFinding = {
  gene: string | null;
  hgvsC: string | null;
  normalizedId: string;
  reviewerLabel: string;
  oncogenicity?: string | null;
  rationale?: string | null;
  engine?: {
    classification: string | null;
    criteriaCodes: string[];
    clinvarSignificance: string | null;
    spliceApplicable: boolean;
    documentHash: string | null;
    engineVersion: string | null;
    runId: number | null;
  } | null;
};

const BLOCK_BOUNDARY = /<\s*\/?\s*(br|p|div|li|tr|td|th|ul|ol|table|thead|tbody)\b[^>]*>/gi;

/** Strip engine markup without a DOM. Used only for report prose, never for HTML render. */
export function stripEngineMarkup(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(BLOCK_BOUNDARY, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatVariantFinding(row: ReportVariantFinding): string {
  const locus = `${row.gene || "Intergenic"} ${row.hgvsC || row.normalizedId}`;
  const extra = row.oncogenicity ? ` / ${row.oncogenicity}` : "";
  const lines = [`${locus}: ${row.reviewerLabel}${extra}`];

  const engine = row.engine;
  if (engine) {
    const suggested = engine.classification || "no classification";
    const codes = engine.criteriaCodes.length ? ` (${engine.criteriaCodes.join(", ")})` : "";
    const bits = [`Engine${engine.engineVersion ? ` ${engine.engineVersion}` : ""} suggested ${suggested}${codes}.`];
    if (engine.clinvarSignificance) bits.push(`ClinVar: ${engine.clinvarSignificance}.`);
    if (engine.spliceApplicable) bits.push("Splicing modelled.");
    if (engine.documentHash) bits.push(`Curation document sha256 ${engine.documentHash}.`);
    lines.push(`  ${bits.join(" ")}`);
  }

  const rationale = stripEngineMarkup(row.rationale);
  if (rationale) lines.push(`  ${rationale}`);
  return lines.join("\n");
}

export function findingsFromApproved(
  rows: ReportVariantFinding[],
  emptyMessage = "No approved variants yet. Describe findings after expert review."
): string {
  if (!rows.length) return emptyMessage;
  return rows.map(formatVariantFinding).join("\n\n");
}

/** Compact pointer stored on the signed snapshot so the hash chain names the engine output. */
export function curationSnapshotEntry(row: ReportVariantFinding) {
  if (!row.engine?.documentHash && !row.engine?.runId) return null;
  return {
    runId: row.engine.runId,
    documentHash: row.engine.documentHash,
    engineVersion: row.engine.engineVersion,
    classification: row.engine.classification,
    gene: row.gene,
    hgvsC: row.hgvsC,
  };
}

export function engineFromSummary(
  summary: CurationSummary | null | undefined,
  extras: { documentHash: string | null; runId: number | null; engineVersion: string | null }
): ReportVariantFinding["engine"] {
  if (!summary && !extras.documentHash) return null;
  return {
    classification: summary?.classification?.label ?? null,
    criteriaCodes: summary?.criteriaCodes ?? [],
    clinvarSignificance: summary?.clinvarSignificance ?? null,
    spliceApplicable: summary?.spliceApplicable ?? false,
    documentHash: extras.documentHash,
    engineVersion: extras.engineVersion || summary?.engineVersion || null,
    runId: extras.runId,
  };
}

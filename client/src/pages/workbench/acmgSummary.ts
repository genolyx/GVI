import type { CurationDocument, CurationScores } from "@shared/curation/document";

type Parsed = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatAf(af: number): string {
  if (af === 0) return "0";
  if (af < 0.0001) return af.toExponential(1);
  return af.toFixed(4);
}

function exonPhrase(doc: CurationDocument): string | null {
  const rank = doc.variant.exon.rank;
  const total = doc.variant.exon.mrnaTotal ?? doc.variant.exon.total;
  if (!rank) return null;
  return total ? `exon ${rank} of ${total}` : `exon ${rank}`;
}

function spliceSite(consequence: string | null): "donor" | "acceptor" | null {
  const value = (consequence || "").toLowerCase();
  if (value.includes("splice_donor")) return "donor";
  if (value.includes("splice_acceptor")) return "acceptor";
  return null;
}

function topSplice(scores: CurationScores): { name: string; value: number } | null {
  const options = [
    { name: "acceptor gain", value: scores.spliceAi.dsAg },
    { name: "acceptor loss", value: scores.spliceAi.dsAl },
    { name: "donor gain", value: scores.spliceAi.dsDg },
    { name: "donor loss", value: scores.spliceAi.dsDl },
  ].filter((item): item is { name: string; value: number } => item.value != null);
  options.sort((a, b) => b.value - a.value);
  return options[0] ?? null;
}

function lossOfFunctionSentence(doc: CurationDocument, parsed: Parsed): string | null {
  const site = spliceSite(doc.variant.consequence);
  const where = exonPhrase(doc);
  const inFrame = parsed.splice_is_in_frame === true;
  const outOfFrame = parsed.splice_is_in_frame === false;
  const protein = text(parsed.exon_skip_predicted_hgvs_p) || text(parsed.hgvs_p) || doc.variant.hgvsP;
  const lost = num(parsed.nmd_escape_truncation_fraction) ?? num(parsed.splice_fraction_lost);
  const nmd = parsed.nmd_escape === true ? "NMD is not predicted" : parsed.nmd_escape === false ? "NMD is expected" : null;
  const splice = topSplice(doc.scores);
  const spliceBit = splice && splice.value >= 0.2 ? `SpliceAI ${splice.name} ${splice.value.toFixed(2)}` : null;
  const plp = num(parsed.skipped_exon_pathogenic_hit_count);

  if (site && outOfFrame) {
    const head = `Out-of-frame ${site} splice${where ? ` at ${where}` : ""}${spliceBit ? ` (${spliceBit})` : ""}`;
    const change = protein ? ` predicts ${protein}` : "";
    const tail = [lost != null ? `losing ${pct(lost)} of the protein` : null, nmd].filter(Boolean).join(", and ");
    return `${head}${change}${tail ? `, ${tail}` : ""}.`;
  }

  if (site && inFrame) {
    const head = `In-frame ${site} skip${where ? ` of ${where}` : ""}`;
    const amount = lost != null ? `removes ${pct(lost)} of the protein` : "removes part of the protein";
    if (plp && plp > 0) return `${head} ${amount}, and the skipped exon has ${plp} ClinVar pathogenic or likely pathogenic variants.`;
    return `${head} ${amount}.`;
  }

  if (lost != null && lost > 0) {
    const kind = (doc.variant.consequence || "null variant").replace(/_/g, " ");
    return `${kind} removes ${pct(lost)} of the protein${nmd ? `, and ${nmd.charAt(0).toLowerCase()}${nmd.slice(1)}` : ""}.`;
  }

  return null;
}

function populationSentence(af: number | null, kind: "rare" | "common" | "frequent"): string | null {
  if (af == null) return null;
  const value = formatAf(af);
  if (kind === "rare") return `gnomAD allele frequency is ${value}, so the variant is absent or extremely rare.`;
  if (kind === "common") return `gnomAD allele frequency is ${value}, which is at least 1%.`;
  return `gnomAD allele frequency is ${value}, which is at least 5%.`;
}

function computationalSentence(doc: CurationDocument, benign: boolean): string | null {
  const splice = topSplice(doc.scores);
  const cadd = doc.scores.caddPhred;
  const revel = doc.scores.revelScore;
  if (splice && splice.value > 0.5 && !benign) {
    return `SpliceAI ${splice.name} is ${splice.value.toFixed(2)}, which supports a splice effect.`;
  }
  if (splice && splice.value > 0 && splice.value < 0.2 && benign) {
    return `SpliceAI ${splice.name} is ${splice.value.toFixed(2)}, which does not support a splice effect.`;
  }
  if (revel != null && revel > 0) return `REVEL is ${revel.toFixed(3)}.`;
  if (cadd != null && cadd > 0) return `CADD is ${cadd.toFixed(1)}.`;
  return null;
}

/** One short sentence citing the review finding that satisfied this criterion. */
export function criterionEvidence(doc: CurationDocument, code: string, rationale: string): string {
  const parsed = doc.engine.parsedData;
  const base = code.split("_")[0]?.toUpperCase() ?? code;
  const fallback = rationale.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  if (base === "PVS1" || base === "PM4") {
    return lossOfFunctionSentence(doc, parsed) || fallback;
  }
  if (base === "PM2") return populationSentence(doc.scores.gnomadAf, "rare") || fallback;
  if (base === "BS1") return populationSentence(doc.scores.gnomadAf, "common") || fallback;
  if (base === "BA1") return populationSentence(doc.scores.gnomadAf, "frequent") || fallback;
  if (base === "PP3") return computationalSentence(doc, false) || fallback;
  if (base === "BP4") return computationalSentence(doc, true) || fallback;
  if (base === "PS1" && doc.variant.hgvsP) return `The same protein change, ${doc.variant.hgvsP}, is already pathogenic.`;
  if (base === "PM5" && doc.variant.hgvsP) return `A different pathogenic missense has been seen at the same residue as ${doc.variant.hgvsP}.`;
  return fallback;
}

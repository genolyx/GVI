import { codingHgvs, displayTranscript } from "@shared/transcript";

const ORDER = ["P", "LP", "VUS", "LB", "B"];

/** Short ClinVar calls. Mixed records keep each call, without the long review-status text. */
export function clinvarShortLabels(value: string): string[] {
  const text = value.toLowerCase();
  const found = new Set<string>();
  if (/\blikely pathogenic\b/.test(text)) found.add("LP");
  if (/\bpathogenic\b/.test(text.replace(/\blikely pathogenic\b/g, " "))) found.add("P");
  if (/\buncertain significance\b/.test(text)) found.add("VUS");
  if (/\blikely benign\b/.test(text)) found.add("LB");
  if (/\bbenign\b/.test(text.replace(/\blikely benign\b/g, " "))) found.add("B");
  const labels = ORDER.filter(label => found.has(label));
  if (!labels.length && /\bconflicting\b/.test(text)) return ["Conflict"];
  return labels;
}

/** ClinVar search for this allele, so a held call can be opened and reviewed. */
export function clinvarRecordUrl(row: {
  gene?: string | null;
  transcript?: string | null;
  hgvsC?: string | null;
}): string | null {
  const change = codingHgvs(row.hgvsC);
  if (!change) return null;
  const transcript = displayTranscript(row.transcript);
  const gene = (row.gene || "").trim();
  const term = transcript
    ? gene
      ? `${transcript}(${gene}):${change}`
      : `${transcript}:${change}`
    : [gene, change].filter(Boolean).join(" ");
  return `https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent(term)}`;
}

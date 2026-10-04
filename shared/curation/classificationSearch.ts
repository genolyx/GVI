/** One-click filters for the Classifications table. Matching is exact, so P does not include LP. */
export const CLASSIFICATION_FAST_SHORTS = ["P", "LP", "VUS", "LB", "B"] as const;

export const CLASSIFICATION_FAST_SEARCH = [
  { short: "P", title: "Pathogenic", labels: ["pathogenic"] },
  { short: "LP", title: "Likely pathogenic", labels: ["likely pathogenic"] },
  { short: "VUS", title: "VUS", labels: ["vus", "uncertain significance"] },
  { short: "LB", title: "Likely benign", labels: ["likely benign"] },
  { short: "B", title: "Benign", labels: ["benign"] },
] as const;

export type ClassificationFastShort = (typeof CLASSIFICATION_FAST_SEARCH)[number]["short"];

export function classificationFastLabels(short: string): readonly string[] | null {
  return CLASSIFICATION_FAST_SEARCH.find(item => item.short === short)?.labels ?? null;
}

export function classificationFastShort(label: string | null | undefined): string {
  const text = (label || "").trim().toLowerCase();
  if (!text) return "";
  return CLASSIFICATION_FAST_SEARCH.find(item => (item.labels as readonly string[]).includes(text))?.short ?? label!.trim();
}

const ORDER = ["Path", "LP", "VUS", "LB", "Benign"];

/** Short ClinVar calls. Mixed records keep each call, without the long review-status text. */
export function clinvarShortLabels(value: string): string[] {
  const text = value.toLowerCase();
  const found = new Set<string>();
  if (/\blikely pathogenic\b/.test(text)) found.add("LP");
  if (/\bpathogenic\b/.test(text.replace(/\blikely pathogenic\b/g, " "))) found.add("Path");
  if (/\buncertain significance\b/.test(text)) found.add("VUS");
  if (/\blikely benign\b/.test(text)) found.add("LB");
  if (/\bbenign\b/.test(text.replace(/\blikely benign\b/g, " "))) found.add("Benign");
  const labels = ORDER.filter(label => found.has(label));
  if (!labels.length && /\bconflicting\b/.test(text)) return ["Conflict"];
  return labels;
}

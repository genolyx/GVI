export type HgmdPs4Check = {
  tag: "DM" | "DM?";
  pmids: string[];
  note: string;
};

const CASE_TAG = /Yes\s*-\s*(DM\?|DM)(?![A-Za-z?])/i;

function pmidFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pmidFrom);
  const text = String(value ?? "").trim();
  const bare = text.match(/^(\d+)(?:\.0+)?$/);
  if (bare) return [bare[1]];
  return [...text.matchAll(/PMID:\s*(\d+)/gi)].map(match => match[1]);
}

/**
 * PS4 suggestion for an HGMD row that cites this allele as disease-causing.
 *
 * DM and DM? are the case-literature tags. Polymorphism tags (DP, FP, DFP) and a
 * miss are not a suggestion. The criterion stays unmet until a reviewer applies it.
 */
export function hgmdPs4Check(hgmdLocal: unknown, pmids?: unknown): HgmdPs4Check | null {
  const text = typeof hgmdLocal === "string" ? hgmdLocal.trim() : "";
  if (!text || /not found/i.test(text)) return null;
  const tagMatch = text.match(CASE_TAG);
  if (!tagMatch) return null;
  const tag = tagMatch[1].toUpperCase() as HgmdPs4Check["tag"];
  const ids = [...new Set([...pmidFrom(pmids), ...pmidFrom(text)])];
  const pmidSentence = ids.length ? ` PMIDs ${ids.join(", ")}.` : "";
  return {
    tag,
    pmids: ids,
    note: `HGMD ${tag}.${pmidSentence} Check the papers for this variant in affected cases before applying PS4.`,
  };
}

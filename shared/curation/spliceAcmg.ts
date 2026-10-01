import type { CriterionStrength, CurationCriterion } from "./document";

/**
 * The splice calculation writes its ClinGen decision into
 * `splice_pvs1_logic_sentence` ("→ PVS1_Strong", "→ PVS1", "→ PM4").
 * That sentence is the review. When the stored ACMG list omitted the code,
 * the curation score still has to show it, and the call stays unchanged
 * until a reviewer accepts it.
 */
export type SpliceReviewCriterion = {
  code: "PVS1" | "PM4";
  engineCode: "PVS1" | "PVS1_Strong" | "PM4";
  strength: Extract<CriterionStrength, "very_strong" | "strong" | "moderate">;
  rationale: string;
};

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&rarr;/g, "→")
    .replace(/&ge;/g, "≥")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function spliceReviewCriterion(
  parsedData: Record<string, unknown> | null | undefined
): SpliceReviewCriterion | null {
  const raw = parsedData?.splice_pvs1_logic_sentence;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const rationale = plainText(raw);
  const match = rationale.match(/→\s*(PVS1_Strong|PVS1|PM4)\b/);
  if (!match) return null;
  const token = match[1];
  if (token === "PVS1_Strong") {
    return { code: "PVS1", engineCode: "PVS1_Strong", strength: "strong", rationale };
  }
  if (token === "PVS1") {
    return { code: "PVS1", engineCode: "PVS1", strength: "very_strong", rationale };
  }
  return { code: "PM4", engineCode: "PM4", strength: "moderate", rationale };
}

/** Engine criteria, plus the splice-review code when the engine list left it out. */
export function criteriaWithSpliceReview(
  criteria: readonly CurationCriterion[],
  parsedData: Record<string, unknown> | null | undefined
): CurationCriterion[] {
  const splice = spliceReviewCriterion(parsedData);
  if (!splice) return [...criteria];
  const present = criteria.some(
    criterion => criterion.baseCode === splice.code || criterion.code === splice.engineCode
  );
  if (present) return [...criteria];
  return [
    ...criteria,
    {
      code: splice.engineCode,
      baseCode: splice.code,
      strength: splice.strength,
      direction: "pathogenic",
      rationale: splice.rationale,
    },
  ];
}

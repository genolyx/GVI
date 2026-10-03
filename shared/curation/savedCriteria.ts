import type { CriterionStrength, CurationCriterion } from "./document";

const STRENGTHS = new Set<string>([
  "stand_alone",
  "very_strong",
  "strong",
  "moderate",
  "supporting",
]);

/** Strength implied by a bare ACMG 2015 code, used when the reviewer did not pick one. */
export function defaultStrengthForCode(code: string): CriterionStrength {
  const upper = code.toUpperCase();
  if (upper === "BA1") return "stand_alone";
  if (upper === "PVS1") return "very_strong";
  if (/^PS\d/.test(upper) || /^BS\d/.test(upper)) return "strong";
  if (/^PM\d/.test(upper)) return "moderate";
  return "supporting";
}

export function savedStrength(raw: string | null | undefined, code: string): CriterionStrength {
  const normalized = raw?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized && STRENGTHS.has(normalized)) return normalized as CriterionStrength;
  return defaultStrengthForCode(code);
}

export type SavedReviewCriterion = {
  code: string;
  state: string;
  strength?: string | null;
  note?: string | null;
};

/**
 * Criteria the reviewer applied on the classification tab, appended when the
 * engine list does not already contain that code.
 */
export function criteriaWithSavedReview(
  criteria: readonly CurationCriterion[],
  saved: readonly SavedReviewCriterion[] | null | undefined
): CurationCriterion[] {
  const present = new Set(criteria.map(item => item.baseCode));
  const extra: CurationCriterion[] = [];
  for (const item of saved ?? []) {
    if (item.state !== "met" || present.has(item.code)) continue;
    extra.push({
      code: item.code,
      baseCode: item.code,
      strength: savedStrength(item.strength, item.code),
      direction: /^B/i.test(item.code) ? "benign" : "pathogenic",
      rationale: item.note?.trim() || "Added on the classification review.",
    });
    present.add(item.code);
  }
  return [...criteria, ...extra];
}

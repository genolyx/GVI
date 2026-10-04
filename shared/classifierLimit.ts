/** How many filtered variants one case may send to the classification engine. */
export const DEFAULT_CLASSIFIER_CASE_LIMIT = 200;
export const MIN_CLASSIFIER_CASE_LIMIT = 1;
export const MAX_CLASSIFIER_CASE_LIMIT = 5000;

export function parseClassifierCaseLimit(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(value)) return null;
  if (value < MIN_CLASSIFIER_CASE_LIMIT || value > MAX_CLASSIFIER_CASE_LIMIT) return null;
  return value;
}

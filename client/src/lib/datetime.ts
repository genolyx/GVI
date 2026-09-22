/**
 * Date and time formatting for the clinical UI.
 *
 * The locale is pinned to en-US rather than inherited from the browser. This is a
 * single-language English product, and a reviewer on a ko-KR or ja-JP machine would
 * otherwise see "2026. 9. 22. 오전 8:46" next to English labels. Clinical records are
 * also read across sites, so a fixed rendering keeps timestamps comparable between
 * reviewers.
 *
 * Timestamps stay in the reader's timezone deliberately: a curator reasoning about
 * when a run finished wants their own wall clock. Report sign-off, where the exact
 * instant matters legally, uses `formatSignatureTimestamp` to name the zone.
 */

const LOCALE = "en-US";

/** "Sep 22, 2026, 8:46 AM" — lists, audit rows, run history. */
export function formatDateTime(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString(LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Sep 22, 2026" — when the time of day carries no meaning. */
export function formatDate(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString(LOCALE, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * "Sep 22, 2026, 8:46:23 AM KST" — report signatures.
 *
 * Seconds and the zone abbreviation are included because this string is part of the
 * signed record a clinician is accountable for.
 */
export function formatSignatureTimestamp(
  value: Date | string | number | null | undefined
): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString(LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

/** Thousands separators for counts, pinned to the same locale as the dates. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(LOCALE);
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

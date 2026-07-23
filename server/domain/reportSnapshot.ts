import { createHash } from "node:crypto";

export type ReportStatus = "draft" | "in_review" | "signed" | "amended";

export function canTransitionReport(from: ReportStatus, to: ReportStatus) {
  return (from === "draft" && to === "in_review") ||
    (from === "in_review" && to === "draft") ||
    (from === "in_review" && to === "signed") ||
    (from === "signed" && to === "amended");
}

export function isReportMutable(status: ReportStatus) {
  return status === "draft";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function createReportDigest(snapshot: Record<string, unknown>) {
  const canonicalJson = JSON.stringify(canonicalize(snapshot));
  return {
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

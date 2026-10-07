export type ReusedAnalysisNotice = {
  gene: string;
  hgvsC: string;
  kind: "case" | "batch" | "single" | "shared";
  label: string;
  batchId: number | null;
  caseId: number | null;
};

function placeLabel(notice: ReusedAnalysisNotice) {
  if (notice.kind === "batch") return `batch ${notice.label}`;
  if (notice.kind === "case") return `case ${notice.label}`;
  return "Single variants";
}

export function reusedAnalysisDescription(notice: ReusedAnalysisNotice) {
  if (notice.kind === "shared") {
    return `${notice.gene} ${notice.hgvsC} already has a completed engine analysis. This entry uses that result, so the classifier did not run again. The institutional call is left open for this organization.`;
  }
  return `${notice.gene} ${notice.hgvsC} already has a completed analysis in ${placeLabel(notice)}. This entry uses that result, so the classifier did not run again.`;
}

export function reusedHref(notice: ReusedAnalysisNotice) {
  if (notice.kind === "shared") return null;
  if (notice.kind === "case" && notice.caseId) return `/cases/${notice.caseId}`;
  if (notice.batchId) return `/workbench/batches/${notice.batchId}`;
  return "/workbench";
}

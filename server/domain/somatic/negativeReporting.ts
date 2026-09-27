export type FullPanelNegativeInput = {
  runStatus: string | null;
  approvedAssertionCount: number;
  unresolvedAssertionCount: number;
  unresolvedAssayFindingCount: number;
  hasDisqualifyingAssayFinding: boolean;
  panelRegionValidationStatus: string | null;
  panelRegionArtifactHash: string | null;
  coverage: {
    validationStatus: string;
    completeRegionCount: number;
    expectedRegionCount: number;
    sourceArtifactHash: string | null;
    validationHash: string | null;
  } | null;
  allowNegativeReporting: boolean;
  policyValidationPassed: boolean;
};

export type FullPanelNegativeEligibility =
  | { allowed: true; reasons: [] }
  | { allowed: false; reasons: string[] };

export function evaluateFullPanelNegative(
  input: FullPanelNegativeInput
): FullPanelNegativeEligibility {
  const reasons: string[] = [];
  if (input.runStatus !== "ready_for_review") reasons.push("RUN_NOT_COMPLETE");
  if (input.approvedAssertionCount > 0) reasons.push("APPROVED_VARIANT_PRESENT");
  if (input.unresolvedAssertionCount > 0) {
    reasons.push("UNRESOLVED_ASSERTIONS");
  }
  if (input.unresolvedAssayFindingCount > 0) {
    reasons.push("UNRESOLVED_ASSAY_FINDINGS");
  }
  if (input.hasDisqualifyingAssayFinding) {
    reasons.push("NON_NEGATIVE_ASSAY_FINDING");
  }
  if (
    input.panelRegionValidationStatus !== "passed" ||
    !input.panelRegionArtifactHash
  ) {
    reasons.push("PANEL_REGIONS_NOT_VALIDATED");
  }
  if (
    !input.coverage ||
    input.coverage.validationStatus !== "passed" ||
    input.coverage.expectedRegionCount < 1 ||
    input.coverage.completeRegionCount !== input.coverage.expectedRegionCount ||
    !input.coverage.sourceArtifactHash ||
    !input.coverage.validationHash
  ) {
    reasons.push("FULL_PANEL_COVERAGE_NOT_VALIDATED");
  }
  if (!input.allowNegativeReporting || !input.policyValidationPassed) {
    reasons.push("NEGATIVE_REPORTING_POLICY_NOT_VALIDATED");
  }
  return reasons.length
    ? { allowed: false, reasons: Array.from(new Set(reasons)).sort() }
    : { allowed: true, reasons: [] };
}

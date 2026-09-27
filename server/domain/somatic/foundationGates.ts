export type GateDecision = {
  allowed: boolean;
  reasons: string[];
};

export type KnowledgeActivationInput = {
  providerEnabled: boolean;
  providerCode: string;
  licenseStatus: "unconfigured" | "approved" | "restricted" | "expired";
  licenseValidTo?: Date | null;
  releaseValidationStatus: "pending" | "passed" | "failed";
  contentHash?: string | null;
  guidelineRecordCount: number;
  offlineEvidenceRecordCount?: number;
  policyEnablesOncoKb: boolean;
  now?: Date;
};

/**
 * Provider releases are deny-by-default. In particular, an OncoKB provider
 * needs both an approved license and an explicit organization policy opt-in.
 */
export function evaluateKnowledgeActivation(
  input: KnowledgeActivationInput
): GateDecision {
  const reasons: string[] = [];
  const now = input.now ?? new Date();

  if (!input.providerEnabled) reasons.push("provider_disabled");
  if (input.licenseStatus !== "approved") reasons.push("license_not_approved");
  if (input.licenseValidTo && input.licenseValidTo.getTime() <= now.getTime()) {
    reasons.push("license_expired");
  }
  if (input.releaseValidationStatus !== "passed") {
    reasons.push("release_validation_not_passed");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.contentHash ?? "")) {
    reasons.push("content_hash_invalid");
  }
  if (input.guidelineRecordCount < 1) {
    reasons.push("guideline_records_missing");
  }
  if (
    input.providerCode.trim().toLowerCase() === "civic" &&
    (input.offlineEvidenceRecordCount ?? 0) < 1
  ) {
    reasons.push("offline_evidence_records_missing");
  }
  if (
    input.providerCode.trim().toLowerCase() === "oncokb" &&
    !input.policyEnablesOncoKb
  ) {
    reasons.push("oncokb_policy_disabled");
  }

  return { allowed: reasons.length === 0, reasons };
}

export type FindingReportabilityInput = {
  status: "detected" | "not_detected" | "not_tested" | "indeterminate";
  policyAllowsNegativeReporting: boolean;
  findingCaseId: number;
  findingPanelVersionId: number;
  panelRegionValidationStatus?: "pending" | "passed" | "failed" | null;
  panelRegionArtifactHash?: string | null;
  coverageCaseId?: number | null;
  coveragePanelVersionId?: number | null;
  panelReportableRegionCount: number;
  coverageValidationStatus?: "pending" | "passed" | "failed" | null;
  expectedRegionCount?: number | null;
  completeRegionCount?: number | null;
  failedRegionCount?: number | null;
  validationHash?: string | null;
};

/**
 * A negative/not-tested result is reportable only when policy explicitly opts
 * in and complete, matching-panel region coverage has been validated.
 */
export function evaluateFindingReportability(
  input: FindingReportabilityInput
): GateDecision {
  if (input.status !== "not_detected" && input.status !== "not_tested") {
    return { allowed: true, reasons: [] };
  }

  const reasons: string[] = [];
  if (!input.policyAllowsNegativeReporting) {
    reasons.push("negative_reporting_policy_disabled");
  }
  if (input.panelReportableRegionCount < 1) {
    reasons.push("panel_reportable_regions_missing");
  }
  if (input.panelRegionValidationStatus !== "passed") {
    reasons.push("panel_region_validation_not_passed");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.panelRegionArtifactHash ?? "")) {
    reasons.push("panel_region_artifact_hash_invalid");
  }
  if (input.coverageCaseId !== input.findingCaseId) {
    reasons.push("coverage_case_mismatch");
  }
  if (input.coveragePanelVersionId !== input.findingPanelVersionId) {
    reasons.push("coverage_panel_mismatch");
  }
  if (input.coverageValidationStatus !== "passed") {
    reasons.push("coverage_validation_not_passed");
  }
  if (
    input.expectedRegionCount !== input.panelReportableRegionCount ||
    input.completeRegionCount !== input.panelReportableRegionCount
  ) {
    reasons.push("coverage_incomplete");
  }
  if ((input.failedRegionCount ?? 0) > 0) {
    reasons.push("region_qc_failed");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.validationHash ?? "")) {
    reasons.push("coverage_validation_hash_invalid");
  }

  return { allowed: reasons.length === 0, reasons };
}

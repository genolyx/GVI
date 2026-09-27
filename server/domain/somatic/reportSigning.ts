export type SomaticSignFinding = {
  assertionId: number;
  tier: "Tier I" | "Tier II" | "Tier III" | "Tier IV";
  level: "A" | "B" | "C" | "D" | null;
};

export type SomaticReportSignPrecondition =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "run_incomplete"
        | "unresolved_assertions"
        | "unresolved_assay_findings"
        | "negative_assay_policy_invalid"
        | "research_only_evidence"
        | "no_approved_findings"
        | "amp_level_missing"
        | "template_unpublished";
      message: string;
    };

/**
 * Evaluate all clinical sign-out gates without database or transport concerns.
 *
 * The ordering intentionally matches the router's historical behavior: run,
 * unresolved, and approved-finding failures share one message; missing AMP
 * levels are reported next; template publication is checked last.
 */
export function evaluateSomaticReportSignPreconditions(input: {
  runStatus: string | null;
  unresolved: number;
  unresolvedAssayFindings?: number;
  invalidNegativeAssayFindings?: number;
  researchOnlyEvidenceCount?: number;
  fullPanelNegativeEligible?: boolean;
  findings: SomaticSignFinding[];
  templateStatus: string | null;
}): SomaticReportSignPrecondition {
  const commonMessage =
    "Sign-out requires a complete run, an approved reportable finding or validated full-panel negative result, no unresolved findings, and no provider limitations.";

  if (input.runStatus !== "ready_for_review") {
    return {
      allowed: false,
      reason: "run_incomplete",
      message: commonMessage,
    };
  }
  if (input.unresolved > 0) {
    return {
      allowed: false,
      reason: "unresolved_assertions",
      message: commonMessage,
    };
  }
  if ((input.unresolvedAssayFindings ?? 0) > 0) {
    return {
      allowed: false,
      reason: "unresolved_assay_findings",
      message:
        "All imported CNV, fusion, MSI, TMB, and HRD findings must be reviewed before sign-out.",
    };
  }
  if ((input.invalidNegativeAssayFindings ?? 0) > 0) {
    return {
      allowed: false,
      reason: "negative_assay_policy_invalid",
      message:
        "A negative assay finding no longer satisfies the active organization policy.",
    };
  }
  if ((input.researchOnlyEvidenceCount ?? 0) > 0) {
    return {
      allowed: false,
      reason: "research_only_evidence",
      message:
        "Research/demo OncoKB evidence cannot be signed into a clinical report.",
    };
  }
  if (!input.findings.length && !input.fullPanelNegativeEligible) {
    return {
      allowed: false,
      reason: "no_approved_findings",
      message: commonMessage,
    };
  }

  const missingLevel = input.findings.find(
    finding =>
      (finding.tier === "Tier I" || finding.tier === "Tier II") &&
      !finding.level
  );
  if (missingLevel) {
    return {
      allowed: false,
      reason: "amp_level_missing",
      message: `Assertion ${missingLevel.assertionId} requires a separate AMP evidence level.`,
    };
  }

  if (input.templateStatus !== "published") {
    return {
      allowed: false,
      reason: "template_unpublished",
      message: "The report template version is not published.",
    };
  }

  return { allowed: true };
}

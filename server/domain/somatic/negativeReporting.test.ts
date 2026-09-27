import { describe, expect, it } from "vitest";
import { evaluateFullPanelNegative } from "./negativeReporting";

const valid = {
  runStatus: "ready_for_review",
  approvedAssertionCount: 0,
  unresolvedAssertionCount: 0,
  unresolvedAssayFindingCount: 0,
  hasDisqualifyingAssayFinding: false,
  panelRegionValidationStatus: "passed",
  panelRegionArtifactHash: "a".repeat(64),
  coverage: {
    validationStatus: "passed",
    completeRegionCount: 120,
    expectedRegionCount: 120,
    sourceArtifactHash: "b".repeat(64),
    validationHash: "c".repeat(64),
  },
  allowNegativeReporting: true,
  policyValidationPassed: true,
};

describe("full-panel negative reporting", () => {
  it("allows only a complete, fully covered, policy-approved negative case", () => {
    expect(evaluateFullPanelNegative(valid)).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("fails closed for incomplete coverage or an invalid policy", () => {
    const result = evaluateFullPanelNegative({
      ...valid,
      coverage: { ...valid.coverage, completeRegionCount: 119 },
      policyValidationPassed: false,
    });
    expect(result).toEqual({
      allowed: false,
      reasons: [
        "FULL_PANEL_COVERAGE_NOT_VALIDATED",
        "NEGATIVE_REPORTING_POLICY_NOT_VALIDATED",
      ],
    });
  });

  it("never calls a case negative when a positive or unresolved result exists", () => {
    const result = evaluateFullPanelNegative({
      ...valid,
      approvedAssertionCount: 1,
      unresolvedAssayFindingCount: 1,
      hasDisqualifyingAssayFinding: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "APPROVED_VARIANT_PRESENT",
        "NON_NEGATIVE_ASSAY_FINDING",
        "UNRESOLVED_ASSAY_FINDINGS",
      ])
    );
  });
});

import { describe, expect, it } from "vitest";
import { evaluateSomaticReportSignPreconditions } from "./reportSigning";

const approvedFinding = {
  assertionId: 41,
  tier: "Tier I" as const,
  level: "A" as const,
};

function evaluate(
  overrides: Partial<
    Parameters<typeof evaluateSomaticReportSignPreconditions>[0]
  > = {}
) {
  return evaluateSomaticReportSignPreconditions({
    runStatus: "ready_for_review",
    unresolved: 0,
    findings: [approvedFinding],
    templateStatus: "published",
    ...overrides,
  });
}

describe("somatic report sign preconditions", () => {
  it("accepts a complete, resolved package using a published template", () => {
    expect(evaluate()).toEqual({ allowed: true });
  });

  it("rejects a partial run before other gates", () => {
    expect(
      evaluate({
        runStatus: "partial",
        unresolved: 2,
        findings: [],
        templateStatus: "draft",
      })
    ).toMatchObject({ allowed: false, reason: "run_incomplete" });
  });

  it("rejects unresolved assertions", () => {
    expect(evaluate({ unresolved: 1 })).toMatchObject({
      allowed: false,
      reason: "unresolved_assertions",
    });
  });

  it("rejects unresolved non-variant assay findings", () => {
    expect(evaluate({ unresolvedAssayFindings: 1 })).toMatchObject({
      allowed: false,
      reason: "unresolved_assay_findings",
    });
  });

  it("rejects a negative assay finding after policy invalidation", () => {
    expect(evaluate({ invalidNegativeAssayFindings: 1 })).toMatchObject({
      allowed: false,
      reason: "negative_assay_policy_invalid",
    });
  });

  it("rejects research/demo OncoKB evidence from clinical sign-out", () => {
    expect(evaluate({ researchOnlyEvidenceCount: 1 })).toMatchObject({
      allowed: false,
      reason: "research_only_evidence",
    });
  });

  it("rejects a package with no approved finding", () => {
    expect(evaluate({ findings: [] })).toMatchObject({
      allowed: false,
      reason: "no_approved_findings",
    });
  });

  it("allows a separately validated full-panel negative package", () => {
    expect(
      evaluate({ findings: [], fullPanelNegativeEligible: true })
    ).toEqual({ allowed: true });
  });

  it.each(["Tier I", "Tier II"] as const)(
    "requires a separate AMP level for %s",
    tier => {
      expect(
        evaluate({
          findings: [{ assertionId: 72, tier, level: null }],
        })
      ).toEqual({
        allowed: false,
        reason: "amp_level_missing",
        message: "Assertion 72 requires a separate AMP evidence level.",
      });
    }
  );

  it("does not require an AMP level for Tier III or IV", () => {
    expect(
      evaluate({
        findings: [
          { assertionId: 73, tier: "Tier III", level: null },
          { assertionId: 74, tier: "Tier IV", level: null },
        ],
      })
    ).toEqual({ allowed: true });
  });

  it("rejects an unpublished report template", () => {
    expect(evaluate({ templateStatus: "retired" })).toEqual({
      allowed: false,
      reason: "template_unpublished",
      message: "The report template version is not published.",
    });
  });
});

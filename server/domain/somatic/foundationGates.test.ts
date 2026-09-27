import { describe, expect, it } from "vitest";
import {
  evaluateFindingReportability,
  evaluateKnowledgeActivation,
} from "./foundationGates";

const HASH = "a".repeat(64);

describe("evaluateKnowledgeActivation", () => {
  it("allows a validated, licensed release with guideline records", () => {
    expect(
      evaluateKnowledgeActivation({
        providerEnabled: true,
        providerCode: "CIViC",
        licenseStatus: "approved",
        releaseValidationStatus: "passed",
        contentHash: HASH,
        guidelineRecordCount: 2,
        offlineEvidenceRecordCount: 10,
        policyEnablesOncoKb: false,
      })
    ).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects a CIViC release without imported offline evidence", () => {
    const decision = evaluateKnowledgeActivation({
      providerEnabled: true,
      providerCode: "CIVIC",
      licenseStatus: "approved",
      releaseValidationStatus: "passed",
      contentHash: HASH,
      guidelineRecordCount: 1,
      offlineEvidenceRecordCount: 0,
      policyEnablesOncoKb: false,
    });

    expect(decision.reasons).toContain("offline_evidence_records_missing");
  });

  it("keeps OncoKB disabled without explicit policy opt-in", () => {
    const decision = evaluateKnowledgeActivation({
      providerEnabled: true,
      providerCode: "OncoKB",
      licenseStatus: "approved",
      releaseValidationStatus: "passed",
      contentHash: HASH,
      guidelineRecordCount: 1,
      policyEnablesOncoKb: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("oncokb_policy_disabled");
  });

  it("rejects expired licenses and failed validation", () => {
    const decision = evaluateKnowledgeActivation({
      providerEnabled: true,
      providerCode: "licensed-source",
      licenseStatus: "approved",
      licenseValidTo: new Date("2025-01-01T00:00:00Z"),
      releaseValidationStatus: "failed",
      contentHash: HASH,
      guidelineRecordCount: 1,
      policyEnablesOncoKb: false,
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "license_expired",
        "release_validation_not_passed",
      ])
    );
  });
});

describe("evaluateFindingReportability", () => {
  it("does not gate detected findings", () => {
    expect(
      evaluateFindingReportability({
        status: "detected",
        policyAllowsNegativeReporting: false,
        findingCaseId: 7,
        findingPanelVersionId: 3,
        panelReportableRegionCount: 0,
      })
    ).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects negative findings by default", () => {
    const decision = evaluateFindingReportability({
      status: "not_detected",
      policyAllowsNegativeReporting: false,
      findingCaseId: 7,
      findingPanelVersionId: 3,
      panelReportableRegionCount: 0,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "negative_reporting_policy_disabled",
        "panel_reportable_regions_missing",
        "coverage_validation_not_passed",
      ])
    );
  });

  it("allows negative reporting only with complete validated coverage", () => {
    expect(
      evaluateFindingReportability({
        status: "not_tested",
        policyAllowsNegativeReporting: true,
        findingCaseId: 7,
        findingPanelVersionId: 3,
        panelRegionValidationStatus: "passed",
        panelRegionArtifactHash: HASH,
        coverageCaseId: 7,
        coveragePanelVersionId: 3,
        panelReportableRegionCount: 42,
        coverageValidationStatus: "passed",
        expectedRegionCount: 42,
        completeRegionCount: 42,
        failedRegionCount: 0,
        validationHash: HASH,
      })
    ).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects coverage from another case", () => {
    const decision = evaluateFindingReportability({
      status: "not_detected",
      policyAllowsNegativeReporting: true,
      findingCaseId: 7,
      findingPanelVersionId: 3,
      panelRegionValidationStatus: "passed",
      panelRegionArtifactHash: HASH,
      coverageCaseId: 8,
      coveragePanelVersionId: 3,
      panelReportableRegionCount: 1,
      coverageValidationStatus: "passed",
      expectedRegionCount: 1,
      completeRegionCount: 1,
      failedRegionCount: 0,
      validationHash: HASH,
    });

    expect(decision.reasons).toContain("coverage_case_mismatch");
  });

  it("rejects negative reporting against an unvalidated panel artifact", () => {
    const decision = evaluateFindingReportability({
      status: "not_detected",
      policyAllowsNegativeReporting: true,
      findingCaseId: 7,
      findingPanelVersionId: 3,
      panelRegionValidationStatus: "pending",
      panelRegionArtifactHash: null,
      coverageCaseId: 7,
      coveragePanelVersionId: 3,
      panelReportableRegionCount: 1,
      coverageValidationStatus: "passed",
      expectedRegionCount: 1,
      completeRegionCount: 1,
      failedRegionCount: 0,
      validationHash: HASH,
    });

    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "panel_region_validation_not_passed",
        "panel_region_artifact_hash_invalid",
      ])
    );
  });
});

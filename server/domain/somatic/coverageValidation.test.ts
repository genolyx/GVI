import { describe, expect, it } from "vitest";
import {
  evaluateRegionCoverageMeasurement,
  evaluateRegionCoverageValidation,
} from "./coverageValidation";

describe("evaluateRegionCoverageMeasurement", () => {
  it("derives QC from the panel thresholds", () => {
    expect(
      evaluateRegionCoverageMeasurement(
        { minimumDepth: 250, minimumCoveragePercent: 95 },
        { meanDepth: 180, coveredPercent: 92 }
      )
    ).toEqual({
      passed: false,
      reasons: [
        "minimum_depth_not_met",
        "minimum_coverage_percent_not_met",
      ],
    });
  });

  it("fails closed when a required metric is absent", () => {
    expect(
      evaluateRegionCoverageMeasurement(
        { minimumDepth: 100, minimumCoveragePercent: 99 },
        { meanDepth: null, coveredPercent: null }
      )
    ).toEqual({
      passed: false,
      reasons: ["mean_depth_missing", "covered_percent_missing"],
    });
  });
});

describe("evaluateRegionCoverageValidation", () => {
  it("passes only when every reportable region passes QC", () => {
    expect(
      evaluateRegionCoverageValidation(
        [1, 2],
        [
          { panelRegionId: 1, qcPassed: true },
          { panelRegionId: 2, qcPassed: true },
        ]
      )
    ).toEqual({
      passed: true,
      completeRegionCount: 2,
      missingRegionIds: [],
      failedRegionIds: [],
    });
  });

  it("reports missing and failed regions", () => {
    expect(
      evaluateRegionCoverageValidation(
        [1, 2, 3],
        [
          { panelRegionId: 1, qcPassed: true },
          { panelRegionId: 2, qcPassed: false },
        ]
      )
    ).toEqual({
      passed: false,
      completeRegionCount: 2,
      missingRegionIds: [3],
      failedRegionIds: [2],
    });
  });

  it("ignores coverage outside the reportable region set", () => {
    expect(
      evaluateRegionCoverageValidation(
        [1],
        [
          { panelRegionId: 1, qcPassed: true },
          { panelRegionId: 99, qcPassed: false },
        ]
      ).passed
    ).toBe(true);
  });
});

export type RegionCoverageValidation = {
  passed: boolean;
  completeRegionCount: number;
  missingRegionIds: number[];
  failedRegionIds: number[];
};

export type RegionCoverageThresholds = {
  minimumDepth: number | null;
  minimumCoveragePercent: number | null;
};

export type RegionCoverageMeasurement = {
  meanDepth: number | null;
  coveredPercent: number | null;
};

export function evaluateRegionCoverageMeasurement(
  thresholds: RegionCoverageThresholds,
  measurement: RegionCoverageMeasurement
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (thresholds.minimumDepth != null) {
    if (measurement.meanDepth == null) {
      reasons.push("mean_depth_missing");
    } else if (measurement.meanDepth < thresholds.minimumDepth) {
      reasons.push("minimum_depth_not_met");
    }
  }
  if (thresholds.minimumCoveragePercent != null) {
    if (measurement.coveredPercent == null) {
      reasons.push("covered_percent_missing");
    } else if (
      measurement.coveredPercent < thresholds.minimumCoveragePercent
    ) {
      reasons.push("minimum_coverage_percent_not_met");
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function evaluateRegionCoverageValidation(
  reportableRegionIds: number[],
  coverage: Array<{ panelRegionId: number; qcPassed: boolean }>
): RegionCoverageValidation {
  const coverageByRegion = new Map(
    coverage.map(record => [record.panelRegionId, record])
  );
  const missingRegionIds = reportableRegionIds.filter(
    id => !coverageByRegion.has(id)
  );
  const failedRegionIds = reportableRegionIds.filter(
    id => coverageByRegion.get(id)?.qcPassed === false
  );

  return {
    passed: missingRegionIds.length === 0 && failedRegionIds.length === 0,
    completeRegionCount: reportableRegionIds.length - missingRegionIds.length,
    missingRegionIds,
    failedRegionIds,
  };
}

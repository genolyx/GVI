import { createHash } from "node:crypto";

export type PanelImpactRegion = {
  regionKey: string;
  regionType: string;
  findingType: string | null;
  gene: string | null;
  chromosome: string | null;
  start: number | null;
  end: number | null;
  transcript: string | null;
  target: Record<string, unknown> | null;
  minimumDepth: number | null;
  minimumCoveragePercent: string | null;
  reportable: boolean;
};

function signature(region: PanelImpactRegion) {
  return JSON.stringify({
    regionKey: region.regionKey,
    regionType: region.regionType,
    findingType: region.findingType,
    gene: region.gene,
    chromosome: region.chromosome,
    start: region.start,
    end: region.end,
    transcript: region.transcript,
    target: region.target,
    minimumDepth: region.minimumDepth,
    minimumCoveragePercent: region.minimumCoveragePercent,
    reportable: region.reportable,
  });
}

export function diffPanelRegions(
  previous: PanelImpactRegion[],
  target: PanelImpactRegion[]
) {
  const previousByKey = new Map(
    previous.map(region => [region.regionKey, region])
  );
  const targetByKey = new Map(target.map(region => [region.regionKey, region]));
  const added = target
    .filter(region => !previousByKey.has(region.regionKey))
    .map(region => region.regionKey)
    .sort();
  const removed = previous
    .filter(region => !targetByKey.has(region.regionKey))
    .map(region => region.regionKey)
    .sort();
  const changed = target
    .filter(region => {
      const prior = previousByKey.get(region.regionKey);
      return prior && signature(prior) !== signature(region);
    })
    .map(region => region.regionKey)
    .sort();
  const payload = { added, removed, changed };

  return {
    ...payload,
    changeHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}

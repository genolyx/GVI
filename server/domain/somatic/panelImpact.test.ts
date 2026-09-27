import { describe, expect, it } from "vitest";
import { diffPanelRegions, type PanelImpactRegion } from "./panelImpact";

function region(
  regionKey: string,
  overrides: Partial<PanelImpactRegion> = {}
): PanelImpactRegion {
  return {
    regionKey,
    regionType: "gene",
    findingType: "CNV",
    gene: regionKey,
    chromosome: null,
    start: null,
    end: null,
    transcript: null,
    target: null,
    minimumDepth: 250,
    minimumCoveragePercent: "95.00",
    reportable: true,
    ...overrides,
  };
}

describe("diffPanelRegions", () => {
  it("classifies added, removed, and changed regions deterministically", () => {
    const result = diffPanelRegions(
      [region("TP53"), region("OLD"), region("EGFR")],
      [
        region("NEW"),
        region("TP53", { minimumDepth: 500 }),
        region("EGFR"),
      ]
    );

    expect(result.added).toEqual(["NEW"]);
    expect(result.removed).toEqual(["OLD"]);
    expect(result.changed).toEqual(["TP53"]);
    expect(result.changeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      diffPanelRegions(
        [region("EGFR"), region("OLD"), region("TP53")],
        [
          region("EGFR"),
          region("TP53", { minimumDepth: 500 }),
          region("NEW"),
        ]
      ).changeHash
    ).toBe(result.changeHash);
  });
});

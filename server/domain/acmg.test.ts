import { describe, expect, it } from "vitest";
import { defaultStrengthForCode, suggestAcmgClassification } from "./acmg";

describe("ACMG 2015 combination helper", () => {
  it("suggests Pathogenic for PVS1 plus a strong criterion", () => {
    expect(suggestAcmgClassification(["PVS1", "PS1"]).classification).toBe("Pathogenic");
  });

  it("suggests Likely Pathogenic for PVS1 plus a moderate criterion", () => {
    expect(suggestAcmgClassification(["PVS1", "PM2"]).classification).toBe("Likely Pathogenic");
  });

  it("suggests Benign for BA1", () => {
    expect(suggestAcmgClassification(["BA1"]).classification).toBe("Benign");
  });

  it("suggests Likely Benign for one strong plus one supporting benign criterion", () => {
    expect(suggestAcmgClassification(["BS1", "BP4"]).classification).toBe("Likely Benign");
  });

  it("returns VUS and flags conflicting pathogenic and benign evidence", () => {
    const result = suggestAcmgClassification(["PVS1", "PS1", "BA1"]);
    expect(result.classification).toBe("VUS");
    expect(result.conflict).toBe(true);
  });

  it("returns VUS when no combination threshold is met", () => {
    expect(suggestAcmgClassification(["PP3"]).classification).toBe("VUS");
  });
});

describe("strength adjustments", () => {
  it("honours an engine downgrade of PVS1 to strong", () => {
    // PVS1 + PM2 at default strength reaches Likely Pathogenic via very-strong +
    // moderate. Downgraded to strong it only has strong + moderate, which lands in
    // the same bucket — but it must no longer be treated as very strong.
    const downgraded = suggestAcmgClassification([
      { code: "PVS1", strength: "strong" },
      { code: "PM2" },
    ]);
    expect(downgraded.counts.veryStrong).toBe(0);
    expect(downgraded.counts.strong).toBe(1);
    expect(downgraded.classification).toBe("Likely Pathogenic");
  });

  it("stops a downgraded PVS1 from reaching Pathogenic on supporting evidence alone", () => {
    // PVS1 + 2 supporting is Pathogenic under ACMG 2015. With PVS1 downgraded to
    // strong it is not, and the old code-derived logic got this wrong.
    const full = suggestAcmgClassification(["PVS1", "PP3", "PP1"]);
    expect(full.classification).toBe("Pathogenic");

    const downgraded = suggestAcmgClassification([
      { code: "PVS1", strength: "strong" },
      { code: "PP3" },
      { code: "PP1" },
    ]);
    expect(downgraded.classification).toBe("Likely Pathogenic");
  });

  it("honours an upgrade of a supporting criterion", () => {
    expect(suggestAcmgClassification(["PP1", "PP3"]).classification).toBe("VUS");
    expect(
      suggestAcmgClassification([{ code: "PP1", strength: "strong" }, { code: "PP3" }])
        .classification
    ).toBe("VUS");
    expect(
      suggestAcmgClassification([
        { code: "PP1", strength: "strong" },
        { code: "PP3", strength: "moderate" },
      ]).classification
    ).toBe("Likely Pathogenic");
  });

  it("counts a repeated code once, keeping the stronger application", () => {
    const result = suggestAcmgClassification([
      { code: "PM2", strength: "moderate" },
      { code: "PM2", strength: "strong" },
    ]);
    expect(result.counts.moderate).toBe(0);
    expect(result.counts.strong).toBe(1);
  });

  it("treats a strengthened benign criterion as strong benign evidence", () => {
    expect(suggestAcmgClassification(["BP4", "BP7"]).classification).toBe("Likely Benign");
    expect(
      suggestAcmgClassification([
        { code: "BP4", strength: "strong" },
        { code: "BP7", strength: "strong" },
      ]).classification
    ).toBe("Benign");
  });

  it("defaults strength from the bare code when none was recorded", () => {
    expect(defaultStrengthForCode("PVS1")).toBe("very_strong");
    expect(defaultStrengthForCode("PS3")).toBe("strong");
    expect(defaultStrengthForCode("PM2")).toBe("moderate");
    expect(defaultStrengthForCode("PP3")).toBe("supporting");
    expect(defaultStrengthForCode("BA1")).toBe("stand_alone");
    expect(defaultStrengthForCode("BS1")).toBe("strong");
    expect(defaultStrengthForCode("BP7")).toBe("supporting");
  });
});

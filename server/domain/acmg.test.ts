import { describe, expect, it } from "vitest";
import { suggestAcmgClassification } from "./acmg";

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

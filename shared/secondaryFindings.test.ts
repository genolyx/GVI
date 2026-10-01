import { describe, expect, it } from "vitest";
import { ACMG_SF_V3_2_GENES, isAcmgSecondaryFindingGene } from "./secondaryFindings";

describe("ACMG SF v3.2", () => {
  it("has the 81-gene v3.2 list, including the calmodulin additions", () => {
    expect(new Set(ACMG_SF_V3_2_GENES).size).toBe(81);
    expect(isAcmgSecondaryFindingGene("calm1")).toBe(true);
    expect(isAcmgSecondaryFindingGene("CALM2")).toBe(true);
    expect(isAcmgSecondaryFindingGene("CALM3")).toBe(true);
    expect(isAcmgSecondaryFindingGene("ATP7A")).toBe(false);
    expect(isAcmgSecondaryFindingGene("MEFV")).toBe(false);
  });
});
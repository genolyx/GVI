import { describe, expect, it } from "vitest";
import { GENE_SCOPE_REQUIRED, hasGeneScopeChoice } from "./geneScope";

describe("gene scope", () => {
  it("accepts a panel, HPO terms, or a gene list", () => {
    expect(hasGeneScopeChoice({})).toBe(false);
    expect(hasGeneScopeChoice({ panelGenes: 2314 })).toBe(true);
    expect(hasGeneScopeChoice({ panelRegions: 12 })).toBe(true);
    expect(hasGeneScopeChoice({ hpo: "Seizure" })).toBe(true);
    expect(hasGeneScopeChoice({ genes: "PAH\nCFTR" })).toBe(true);
    expect(hasGeneScopeChoice({ hpo: "   ", genes: " " })).toBe(false);
    expect(GENE_SCOPE_REQUIRED).toContain("gene panel");
  });
});

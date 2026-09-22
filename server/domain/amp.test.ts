import { describe, expect, it } from "vitest";
import {
  civicLevelToAmp,
  describeSomaticDivergence,
  oncokbLevelToAmp,
  oncokbOncogenicity,
  suggestAmpClassification,
  type AmpFact,
} from "./amp";

const fact = (partial: Partial<AmpFact> & Pick<AmpFact, "source">): AmpFact => ({
  ampLevel: null,
  clinicalDomain: "therapeutic",
  sameTumor: true,
  ...partial,
});

describe("AMP level maps", () => {
  it("maps OncoKB therapeutic and Dx/Px levels onto AMP A–D", () => {
    expect(oncokbLevelToAmp("LEVEL_1")).toBe("A");
    expect(oncokbLevelToAmp("LEVEL_2")).toBe("A");
    expect(oncokbLevelToAmp("LEVEL_3A")).toBe("B");
    expect(oncokbLevelToAmp("LEVEL_3B")).toBe("C");
    expect(oncokbLevelToAmp("LEVEL_4")).toBe("D");
    expect(oncokbLevelToAmp("LEVEL_R1")).toBe("A");
    expect(oncokbLevelToAmp("LEVEL_Dx1")).toBe("A");
    expect(oncokbLevelToAmp("unknown")).toBeNull();
  });

  it("maps CIViC A–E onto AMP A–D", () => {
    expect(civicLevelToAmp("A")).toBe("A");
    expect(civicLevelToAmp("E")).toBe("D");
    expect(civicLevelToAmp("")).toBeNull();
  });

  it("maps OncoKB oncogenic labels onto the five-tier scale", () => {
    expect(oncokbOncogenicity("Oncogenic")).toBe("Oncogenic");
    expect(oncokbOncogenicity("Likely Neutral")).toBe("Likely Benign");
    expect(oncokbOncogenicity("Unknown")).toBe("VUS");
  });
});

describe("suggestAmpClassification", () => {
  it("calls Tier I for FDA / guideline-level therapy evidence", () => {
    const result = suggestAmpClassification([
      fact({ source: "OncoKB", ampLevel: "A", oncogenicLabel: "Oncogenic" }),
    ]);
    expect(result.tier).toBe("Tier I");
    expect(result.oncogenicity).toBe("Oncogenic");
    expect(result.conflict).toBe(false);
  });

  it("calls Tier II for preclinical / other-tumour evidence", () => {
    const result = suggestAmpClassification([
      fact({ source: "CIViC", ampLevel: "D", clinicalDomain: "therapeutic", sameTumor: false }),
    ]);
    expect(result.tier).toBe("Tier II");
    expect(result.oncogenicity).toBe("VUS");
  });

  it("calls Tier IV / Benign for a common polymorphism with no cancer evidence", () => {
    const result = suggestAmpClassification([
      fact({ source: "gnomAD", clinicalDomain: "population", populationAf: 0.08, sameTumor: false }),
    ]);
    expect(result.tier).toBe("Tier IV");
    expect(result.oncogenicity).toBe("Benign");
  });

  it("calls Tier III when nothing is known", () => {
    const result = suggestAmpClassification([]);
    expect(result.tier).toBe("Tier III");
    expect(result.oncogenicity).toBe("VUS");
  });

  it("flags a conflict when actionability and a benign call disagree", () => {
    const result = suggestAmpClassification([
      fact({ source: "OncoKB", ampLevel: "A" }),
      fact({ source: "OncoKB", clinicalDomain: "oncogenicity", oncogenicLabel: "Likely Neutral" }),
    ]);
    expect(result.tier).toBe("Tier I");
    expect(result.oncogenicity).toBe("Likely Benign");
    expect(result.conflict).toBe(true);
  });
});

describe("describeSomaticDivergence", () => {
  const suggestion = suggestAmpClassification([
    fact({ source: "OncoKB", ampLevel: "A", oncogenicLabel: "Oncogenic" }),
  ]);

  it("is advisory when the reviewer has not classified yet", () => {
    const gap = describeSomaticDivergence(null, suggestion);
    expect(gap.diverges).toBe(false);
  });

  it("reports a mismatch when the reviewer picked a different tier", () => {
    const gap = describeSomaticDivergence({ somaticTier: "Tier III", oncogenicity: "VUS" }, suggestion);
    expect(gap.diverges).toBe(true);
    expect(gap.message).toMatch(/Tier III vs suggested Tier I/);
  });
});

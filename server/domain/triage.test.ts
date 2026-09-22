import { describe, expect, it } from "vitest";
import { triageVariant, type TriageInput } from "./triage";

function variant(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    gene: "AMT",
    consequence: "missense_variant",
    impact: "MODERATE",
    populationAf: null,
    clinvarSignificance: null,
    hgvsC: "c.878G>A",
    referenceBuild: "GRCh38",
    ...overrides,
  };
}

describe("triage tiers", () => {
  it("queues a rare loss-of-function variant for curation", () => {
    const result = triageVariant(
      variant({
        impact: "HIGH",
        consequence: "splice_acceptor_variant",
        populationAf: "0.0000010000",
      })
    );
    expect(result.tier).toBe("t1_curate");
    expect(result.reasons).toContain("Predicted HIGH impact");
  });

  it("filters a variant that is too common to cause a rare disease", () => {
    const result = triageVariant(variant({ impact: "HIGH", populationAf: "0.0500000000" }));
    expect(result.tier).toBe("t3_filtered");
    expect(result.reasons[0]).toMatch(/at or above/);
  });

  it("keeps a common variant when ClinVar calls it pathogenic", () => {
    // Founder variants can exceed 1% in a population and still be causal, so the
    // frequency filter must not override a curated human assertion.
    const result = triageVariant(
      variant({ populationAf: "0.0300000000", clinvarSignificance: "Pathogenic" })
    );
    expect(result.tier).toBe("t1_curate");
  });

  it("filters a confidently benign variant", () => {
    const result = triageVariant(variant({ clinvarSignificance: "Benign" }));
    expect(result.tier).toBe("t3_filtered");
  });

  it("does not filter on a conflicting ClinVar entry", () => {
    const result = triageVariant(
      variant({
        impact: "HIGH",
        consequence: "stop_gained",
        clinvarSignificance: "Conflicting interpretations of pathogenicity",
      })
    );
    expect(result.tier).toBe("t1_curate");
    expect(result.reasons.some(reason => reason.includes("conflict"))).toBe(true);
  });

  it("does not park a GRCh37 variant that has gene + HGVS c.", () => {
    // Genomic coordinates are lifted at enqueue. HGVS is transcript-relative, so a
    // high-impact GRCh37 variant is still worth engine time.
    const result = triageVariant(
      variant({ impact: "HIGH", consequence: "stop_gained", referenceBuild: "GRCh37" })
    );
    expect(result.tier).toBe("t1_curate");
  });

  it("holds a variant the engine cannot address for review", () => {
    expect(triageVariant(variant({ gene: null })).tier).toBe("t2_review");
    expect(triageVariant(variant({ hgvsC: null })).tier).toBe("t2_review");
  });

  it("promotes a panel gene above the curation threshold", () => {
    const plain = triageVariant(variant({ populationAf: "0.0000500000" }));
    expect(plain.tier).toBe("t2_review");

    const onPanel = triageVariant(variant({ populationAf: "0.0000500000" }), {
      panelGenes: new Set(["AMT"]),
    });
    expect(onPanel.tier).toBe("t1_curate");
    expect(onPanel.score).toBeGreaterThan(plain.score);
  });

  it("ignores panel membership when no panel was ordered", () => {
    const result = triageVariant(variant(), { panelGenes: new Set() });
    expect(result.reasons.some(reason => reason.includes("panel"))).toBe(false);
  });

  it("curates a deep intronic variant on splice-region consequence alone", () => {
    // Annotation calls these LOW impact, but splicing is the engine's strength.
    const result = triageVariant(
      variant({
        impact: "LOW",
        consequence: "splice_region_variant",
        populationAf: "0.0000010000",
        gene: "NEB",
        hgvsC: "c.21522+3A>T",
      })
    );
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.tier).toBe("t2_review");
  });

  it("filters a synonymous variant with nothing going for it", () => {
    const result = triageVariant(
      variant({ impact: "LOW", consequence: "synonymous_variant", populationAf: "0.0010000000" })
    );
    expect(result.tier).toBe("t3_filtered");
  });

  it("scores unknown frequency above a known-common one", () => {
    const unknown = triageVariant(variant({ impact: "HIGH", populationAf: null }));
    const rare = triageVariant(variant({ impact: "HIGH", populationAf: "0.0000010000" }));
    expect(rare.score).toBeGreaterThan(unknown.score);
    expect(unknown.reasons).toContain("No population frequency available");
  });
});

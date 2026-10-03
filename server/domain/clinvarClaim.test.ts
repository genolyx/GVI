import { describe, expect, it } from "vitest";
import type { CurationDocument } from "../../shared/curation/document";
import { clinvarAlleleSearchUrl, withoutUnmatchedClinvar } from "./clinvarClaim";

function document(): CurationDocument {
  return {
    contractVersion: "1.0",
    meta: {
      engineVersion: "v11",
      generatedAt: "2026-10-03T00:00:00Z",
      durationMs: 1,
      referenceBuild: "GRCh38",
      sourcesConsulted: [],
      sourcesDisabled: [],
      warnings: [],
    },
    variant: {
      chromosome: "8",
      position: 93803640,
      referenceAllele: "GA",
      alternateAllele: "G",
      gene: "TMEM67",
      transcript: "NM_153704.6",
      hgvsC: "c.2280del",
      hgvsP: "p.Asp761IlefsTer12",
      consequence: "frameshift_variant",
      effectiveGene: "TMEM67",
    },
    scores: {
      gnomadAf: null,
      caddPhred: null,
      revelScore: null,
      spliceAi: { dsAg: null, dsAl: null, dsDg: null, dsDl: null },
    },
    acmg: { classification: null, criteria: [] },
    highlights: {
      clinvarSignificance: "Uncertain significance",
      clinvarIdenticalPathogenic: false,
      spliceApplicable: false,
      literatureStatus: "none",
    },
    engine: {
      parsedData: {
        clinvar_rcv: "1493140",
        clinvar_sig: "Uncertain significance",
        clinvar_search_link: "https://www.ncbi.nlm.nih.gov/clinvar/?term=TMEM67%5Bgene%5D%20AND%20c.2280del",
        transcript: "NM_153704.6",
        c_dot: "c.2280del",
        grch38_chrom: "chr8",
        grch38_start: 93803641,
        ref: "AA",
        alt: "A",
        logic_explanation:
          "This variant — Uncertain significance (<a href='https://www.ncbi.nlm.nih.gov/clinvar/variation/1493140/' target='_blank' rel='noopener'>ClinVar 1493140</a>)<br>Same amino acid change: c.2283T>C",
      },
    },
  } as CurationDocument;
}

describe("saved ClinVar claims", () => {
  it("drops a variation that is not this allele", () => {
    const next = withoutUnmatchedClinvar(document(), null);
    expect(next.engine.parsedData.clinvar_rcv).toBe("");
    expect(next.engine.parsedData.clinvar_sig).toBe("Not found in public databases");
    expect(next.highlights.clinvarSignificance).toBeNull();
    expect(String(next.engine.parsedData.logic_explanation)).toContain("This variant is not in ClinVar.");
    expect(String(next.engine.parsedData.logic_explanation)).not.toContain("1493140");
    expect(String(next.engine.parsedData.logic_explanation)).toContain("c.2283T>C");
    expect(String(next.engine.parsedData.clinvar_search_link)).toContain(
      encodeURIComponent("NM_153704.6(TMEM67):c.2280del")
    );
  });

  it("keeps a variation that is this allele", () => {
    const source = document();
    expect(withoutUnmatchedClinvar(source, "1493140")).toBe(source);
  });

  it("builds a transcript-qualified search", () => {
    expect(clinvarAlleleSearchUrl("TSC1", "NM_000368.5", "c.2270A>C")).toBe(
      `https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent("NM_000368.5(TSC1):c.2270A>C")}`
    );
  });
});

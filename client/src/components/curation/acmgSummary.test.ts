import { describe, expect, it } from "vitest";
import type { CurationDocument } from "@shared/curation/document";
import { criterionEvidence } from "../../pages/workbench/acmgSummary";

function doc(patch: {
  consequence: string;
  exonRank?: number;
  exonTotal?: number;
  gnomadAf?: number | null;
  dsDl?: number | null;
  parsed?: Record<string, unknown>;
}): CurationDocument {
  return {
    variant: {
      consequence: patch.consequence,
      hgvsC: "c.444+1G>A",
      hgvsP: null,
      exon: { rank: patch.exonRank ?? 3, total: 14, codingRank: null, codingTotal: null, mrnaTotal: patch.exonTotal ?? 15 },
    },
    scores: {
      gnomadAf: patch.gnomadAf ?? 0,
      caddPhred: 22.7,
      revelScore: 0,
      spliceAi: { dsAg: 0.01, dsAl: 0.01, dsDg: 0.94, dsDl: patch.dsDl ?? 1, dpAg: null, dpAl: null, dpDg: null, dpDl: null, fetched: true, source: "broad" },
      pangolin: { dsSg: null, dsSl: null, dpSg: null, dpSl: null, fetched: false },
    },
    engine: { parsedData: patch.parsed ?? {} },
  } as CurationDocument;
}

describe("criterion evidence sentences", () => {
  it("cites the out-of-frame splice finding from the review", () => {
    const sentence = criterionEvidence(
      doc({
        consequence: "splice_donor_variant&intron_variant",
        parsed: {
          splice_is_in_frame: false,
          nmd_escape: false,
          nmd_escape_truncation_fraction: 0.7956,
          exon_skip_predicted_hgvs_p: "p.Glu107fsTer5",
        },
      }),
      "PVS1",
      "Canonical splice predicted out-of-frame (presumed NMD)"
    );
    expect(sentence).toBe(
      "Out-of-frame donor splice at exon 3 of 15 (SpliceAI donor loss 1.00) predicts p.Glu107fsTer5, losing 79.6% of the protein, and NMD is expected."
    );
  });

  it("asks for a mechanism lookup when PVS1 is met and the mechanism is unknown", () => {
    const sentence = criterionEvidence(
      doc({
        consequence: "splice_donor_variant&intron_variant",
        parsed: {
          splice_is_in_frame: false,
          nmd_escape: false,
          nmd_escape_truncation_fraction: 0.7956,
          exon_skip_predicted_hgvs_p: "p.Glu107fsTer5",
          disease_mechanism: "Unknown",
        },
      }),
      "PVS1",
      "Canonical splice predicted out-of-frame (presumed NMD)"
    );
    expect(sentence).toContain("Mechanism unknown — look up.");
  });

  it("cites the gnomAD frequency for PM2", () => {
    const sentence = criterionEvidence(doc({ consequence: "splice_donor_variant", gnomadAf: 0 }), "PM2", "rare");
    expect(sentence).toBe("gnomAD allele frequency is 0, so the variant is absent or extremely rare.");
  });
});

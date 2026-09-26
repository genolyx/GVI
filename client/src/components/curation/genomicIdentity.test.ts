import { describe, expect, it } from "vitest";
import { genomicIdentity } from "../../pages/workbench/genomicIdentity";

describe("genomicIdentity", () => {
  it("reverse-complements a minus-strand SNV that was stored on the transcript strand", () => {
    const identity = genomicIdentity(
      { chromosome: "chr17", start: 7675088, end: 7675088, referenceAllele: "G", alternateAllele: "A", strand: -1 },
      {},
    );
    expect(identity.hgvsG).toBe("chr17:g.7675088C>T");
    expect(identity.lookup).toEqual({ chrom: "chr17", start: 7675088, end: 7675088, ref: "C", alt: "T" });
  });

  it("keeps forward-strand alleles when the engine already normalized them", () => {
    const identity = genomicIdentity(
      { chromosome: "chr17", start: 7675088, end: 7675088, referenceAllele: "C", alternateAllele: "T", strand: -1 },
      { alleles_are_forward: true, hgvs_g: "chr17:g.7675088C>T", rsid: "rs28934578" },
    );
    expect(identity.hgvsG).toBe("chr17:g.7675088C>T");
    expect(identity.rsid).toBe("rs28934578");
  });

  it("reads a stored VEP VCF string as forward genomic alleles", () => {
    const identity = genomicIdentity(
      { chromosome: "chr17", start: 7675088, end: 7675088, referenceAllele: "G", alternateAllele: "A", strand: -1 },
      { vep_vcf_string: "17-7675088-C-T" },
    );
    expect(identity.hgvsG).toBe("chr17:g.7675088C>T");
  });
});

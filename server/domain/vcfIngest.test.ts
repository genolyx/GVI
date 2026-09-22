import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import { variantReingestSet, variantReingestTarget } from "./vcfIngest";

describe("VCF re-ingest", () => {
  it("keys a variant by build + locus so a second upload of the same file collides", () => {
    const vcf = [
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
      "1\t100\t.\tA\tG\t.\tPASS\tGENE=AMT;HGVSC=c.1A>G",
    ].join("\n");
    const first = parseVcf(vcf, "GRCh38");
    const second = parseVcf(vcf, "GRCh38");
    expect(first[0].normalizedId).toBe("GRCh38:1:100:A:G");
    expect(first[0].normalizedId).toBe(second[0].normalizedId);
  });

  it("refreshes annotation columns on conflict and leaves reviewer identity alone", () => {
    expect(Object.keys(variantReingestSet)).toEqual(
      expect.arrayContaining([
        "gene",
        "hgvsC",
        "populationAf",
        "clinvarSignificance",
        "annotation",
      ])
    );
    expect(Object.keys(variantReingestSet)).not.toEqual(expect.arrayContaining(["reviewStatus", "id"]));
    expect(variantReingestTarget).toHaveLength(3);
  });
});

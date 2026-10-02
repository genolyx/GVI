import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import { ingestFailureMessage, variantReingestSet, variantReingestTarget } from "./vcfIngest";

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

  it("keeps the database cause and drops the SQL dump", () => {
    const dumped = new Error("Failed query: insert into variants values ($1, $2)");
    dumped.cause = new Error("value too long for type character varying(160)");
    expect(ingestFailureMessage(dumped)).toBe(
      "value too long for type character varying(160)"
    );
    expect(ingestFailureMessage(new Error("VCF checksum mismatch"))).toBe(
      "VCF checksum mismatch"
    );
  });
});

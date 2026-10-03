import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";

const VCF = [
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
  "chrX\t136874252\t.\tC\tA\t13.4\tPASS\t.\tGT:GQ:DP:AD:VAF:PL\t0/1:13:160:106,52:0.325:13,0,53",
  "chrX\t67545316\t.\tT\tTGCAGCAGCA\t34.6\tPASS\t.\tGT:GQ:DP:AD:VAF:PL\t1/1:4:47:29,8:0.170213:32,1,0",
  "chrX\t47185305\t.\tG\tA\t68.7\tPASS\t.\tGT:GQ:DP:AD:VAF:PL\t1/1:60:134:0,130:0.970149:68,61,0",
  "chrX\t1\t.\tA\tG\t50\tPASS\t.\tGT:DP:AD\t1:40:0,40",
  "1\t10\t.\tA\tG\t40\tPASS\t.\tGT:DP\t0/1:20",
].join("\n");

describe("VCF genotype and allele depth", () => {
  const parsed = parseVcf(VCF, "GRCh38");

  it("keeps a heterozygous chrX genotype and the AD reference count", () => {
    expect(parsed[0]).toMatchObject({
      chromosome: "X",
      zygosity: "0/1",
      readDepth: 160,
      referenceDepth: 106,
      alternateDepth: 52,
    });
  });

  it("keeps a diploid chrX 1/1 call and does not invent reference reads from total depth", () => {
    expect(parsed[1]).toMatchObject({
      chromosome: "X",
      zygosity: "1/1",
      readDepth: 47,
      referenceDepth: 29,
      alternateDepth: 8,
    });
    expect(parsed[2]).toMatchObject({
      zygosity: "1/1",
      referenceDepth: 0,
      alternateDepth: 130,
    });
  });

  it("keeps a haploid genotype as a single allele", () => {
    expect(parsed[3]).toMatchObject({
      zygosity: "1",
      referenceDepth: 0,
      alternateDepth: 40,
    });
  });

  it("leaves the reference depth empty when the sample has no AD field", () => {
    expect(parsed[4]).toMatchObject({
      zygosity: "0/1",
      readDepth: 20,
      referenceDepth: null,
      alternateDepth: null,
    });
  });
});

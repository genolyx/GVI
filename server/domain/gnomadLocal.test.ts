import { config } from "dotenv";
import { describe, expect, it } from "vitest";

config({ path: ".env.local", quiet: true });
import {
  chooseGnomadAf,
  gnomadSiteKey,
  lookupLocalGnomad,
  parseAlleleFrequencyLines,
  pickChromosomeFile,
} from "./gnomadLocal";

describe("local gnomAD allele choice", () => {
  it("prefers a non-zero exome frequency, then genomes, then a zero exome frequency", () => {
    expect(chooseGnomadAf(0.21884, 0.406875)).toBe(0.21884);
    expect(chooseGnomadAf(0, 0.407027)).toBe(0.407027);
    expect(chooseGnomadAf(0, null)).toBe(0);
    expect(chooseGnomadAf(null, null)).toBeNull();
  });

  it("does not treat chr10 as chr1", () => {
    const files = [
      "/data/gnomad.genomes.v4.1.sites.chr1.vcf.bgz",
      "/data/gnomad.genomes.v4.1.sites.chr10.vcf.bgz",
    ];
    expect(pickChromosomeFile(files, "1")).toContain("chr1.vcf");
    expect(pickChromosomeFile(files, "chr10")).toContain("chr10.vcf");
    expect(pickChromosomeFile(files, "2")).toBeNull();
  });

  it("keeps the requested allele when many alleles share the position", () => {
    const found = parseAlleleFrequencyLines(
      [
        "chr8\t10610142\tG\tA\t0.000168056",
        "chr8\t10610142\tG\tC\t0.406875",
        "chr8\t10610140\tCCG\tC\t6.64125e-06",
      ].join("\n")
    );
    expect(found.get(gnomadSiteKey({
      chromosome: "8",
      position: 10610142,
      referenceAllele: "G",
      alternateAllele: "C",
    }))).toBeCloseTo(0.406875);
    expect(found.get(gnomadSiteKey({
      chromosome: "chr8",
      position: 10610142,
      referenceAllele: "g",
      alternateAllele: "a",
    }))).toBeCloseTo(0.000168056);
  });
});

describe("installed gnomAD release", () => {
  it("reads the common and rare alleles at the RP1L1 site", async () => {
    if (!process.env.VC_GNOMAD_DIR && !process.env.VC_GNOMAD_PATH) return;
    const found = await lookupLocalGnomad([
      { chromosome: "8", position: 10610142, referenceAllele: "G", alternateAllele: "C" },
      { chromosome: "8", position: 10610142, referenceAllele: "G", alternateAllele: "A" },
    ]);
    expect(found).not.toBeNull();
    if (!found) return;
    const common = found.get("8:10610142:G:C");
    const rare = found.get("8:10610142:G:A");
    expect(common).toBeGreaterThan(0.2);
    expect(rare).toBeLessThan(0.01);
  }, 60_000);
});

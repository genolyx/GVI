import { describe, expect, it } from "vitest";
import { parseClingenRelease, parseClinvarFileDate, parseClinvarMode, parseGnomadMode, parseGnomadRelease, parseHgmdRelease, parsePmid } from "./referenceData";

describe("reference data labels", () => {
  it("reads a PMID from a downloaded literature filename", () => {
    expect(parsePmid("PMID_37980560_INTS11.pdf")).toBe("37980560");
    expect(parsePmid("SciHub_PMID_12345678_title.pdf")).toBe("12345678");
    expect(parsePmid("notes.txt")).toBeNull();
  });

  it("reads the ClinVar fileDate header", () => {
    const header = "##fileformat=VCFv4.1\n##fileDate=2026-01-11\n##source=ClinVar\n";
    expect(parseClinvarFileDate(header)).toBe("2026-01-11");
    expect(parseClinvarFileDate("##fileformat=VCFv4.1\n")).toBeNull();
  });

  it("reads the ClinVar source choice", () => {
    expect(parseClinvarMode("local\n")).toBe("local");
    expect(parseClinvarMode("NCBI")).toBe("ncbi");
    expect(parseClinvarMode("myvariant")).toBeNull();
  });

  it("reads the gnomAD source choice", () => {
    expect(parseGnomadMode("local\n")).toBe("local");
    expect(parseGnomadMode("MyVariant")).toBe("myvariant");
    expect(parseGnomadMode("r4")).toBeNull();
  });

  it("reads the gnomAD release from the filename", () => {
    expect(parseGnomadRelease("gnomad.genomes.v3.1.2.sites.chr22.vcf.bgz")).toBe("v3.1.2");
    expect(parseGnomadRelease("notes.vcf.gz")).toBeNull();
  });

  it("reads the HGMD release from the filename", () => {
    expect(parseHgmdRelease("/data/HGMD_2025_V4_hg38.xltx")).toBe("2025 V4");
    expect(parseHgmdRelease("hgmd_2025_v4_hg38.vcf.gz")).toBe("2025 V4");
    expect(parseHgmdRelease("notes.xlsx")).toBeNull();
  });

  it("reads the ClinGen release date comment", () => {
    expect(parseClingenRelease("#ClinGen Gene Curation Results\n#22 Sep,2026\n")).toBe("22 Sep,2026");
  });
});

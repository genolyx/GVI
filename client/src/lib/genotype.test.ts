import { describe, expect, it } from "vitest";
import { alleleDepthLabel, zygosityLabel } from "./genotype";

describe("zygosityLabel", () => {
  it("reads 0/1 as heterozygous", () => {
    expect(zygosityLabel("0/1").label).toBe("Heterozygous");
    expect(zygosityLabel("1/0").label).toBe("Heterozygous");
    expect(zygosityLabel("0|1").label).toBe("Heterozygous");
  });

  it("reads 1/1 as homozygous alternate", () => {
    expect(zygosityLabel("1/1").label).toBe("Homozygous");
  });

  it("reads a single allele as hemizygous", () => {
    expect(zygosityLabel("1").label).toBe("Hemizygous");
  });

  it("does not call a 17% site homozygous", () => {
    const label = zygosityLabel("1/1", 47, 8);
    expect(label.label).toBe("Possible mosaic");
    expect(label.title).toContain("Genotype 1/1");
  });

  it("keeps a balanced 0/1 site heterozygous", () => {
    expect(zygosityLabel("0/1", 140, 70).label).toBe("Heterozygous");
  });

  it("keeps a nearly complete alternate site homozygous", () => {
    expect(zygosityLabel("1/1", 100, 98).label).toBe("Homozygous");
  });
});

describe("alleleDepthLabel", () => {
  it("splits a balanced heterozygous site into reference and alternate reads", () => {
    const depth = alleleDepthLabel(140, 70);
    expect(depth.text).toBe("70 / 70");
    expect(depth.percent).toBe("50%");
    expect(depth.title).toContain("70 reference reads, 70 alternate reads, 140 total");
  });

  it("keeps an unbalanced site in reference / alternate order", () => {
    const depth = alleleDepthLabel(31, 14);
    expect(depth.text).toBe("17 / 14");
    expect(depth.percent).toBe("45%");
  });

  it("shows a low alternate share that a reviewer can compare with 50%", () => {
    expect(alleleDepthLabel(16, 2).percent).toBe("13%");
  });

  it("uses the VCF allele-depth reference count when total depth is higher", () => {
    const ar = alleleDepthLabel(47, 8, 29);
    expect(ar.text).toBe("29 / 8");
    expect(ar.percent).toBe("17%");
    expect(ar.title).toContain("10 reads are not assigned to either allele");

    const rbmx = alleleDepthLabel(160, 52, 106);
    expect(rbmx.text).toBe("106 / 52");
    expect(rbmx.percent).toBe("33%");

    expect(alleleDepthLabel(134, 130, 0).text).toBe("0 / 130");
  });
});

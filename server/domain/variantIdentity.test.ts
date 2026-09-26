import { describe, expect, it } from "vitest";
import { matchClinvarRecords, normalizeRsid, rsidFromEnsembl, rsidFromMyvariant } from "./variantIdentity";

describe("variant identity parsers", () => {
  it("reads the dbSNP RS field and genomic HGVS from a ClinVar query line", () => {
    const text = [
      "C\tA\t28934578\tNC_000017.11:g.7675088C>A",
      "C\tT\t28934578\tNC_000017.11:g.7675088C>T",
    ].join("\n");
    expect(matchClinvarRecords(text, "C", "T")).toEqual({
      rsid: "rs28934578",
      hgvsG: "NC_000017.11:g.7675088C>T",
    });
  });

  it("ignores a ClinVar row for a different allele", () => {
    expect(matchClinvarRecords("C\tA\t28934578\tNC_000017.11:g.7675088C>A\n", "G", "A")).toBeNull();
  });

  it("accepts an rs-prefixed id and a bare ClinVar RS number", () => {
    expect(normalizeRsid("28934578")).toBe("rs28934578");
    expect(normalizeRsid("rs28934578")).toBe("rs28934578");
    expect(normalizeRsid(".")).toBeNull();
  });

  it("reads MyVariant and Ensembl rs ids", () => {
    expect(rsidFromMyvariant({ dbsnp: { rsid: "rs28934578" } })).toBe("rs28934578");
    expect(rsidFromEnsembl([{ colocated_variants: [{ id: "CM062017", start: 7675088 }, { id: "rs28934578", start: 7675088 }] }], 7675088)).toBe("rs28934578");
  });
});

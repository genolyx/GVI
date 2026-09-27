import { describe, expect, it } from "vitest";
import {
  parseGermlineBed,
  parseGermlineGeneText,
  variantOverlapsPanel,
} from "./germlinePanel";

describe("germline panel scope", () => {
  it("keeps a named gene list in stable order", () => {
    expect(parseGermlineGeneText("CFTR, HBB\nGJB2")).toEqual([
      "CFTR",
      "GJB2",
      "HBB",
    ]);
  });

  it("converts 0-based BED intervals and reads gene names", () => {
    const panel = parseGermlineBed(
      "track name=panel\nchr7\t117480025\t117668665\tCFTR\n7\t100\t120\tIGNORED\n"
    );
    expect(panel.regions).toEqual([
      {
        chromosome: "chr7",
        start: 117480026,
        end: 117668665,
        name: "CFTR",
      },
      { chromosome: "7", start: 101, end: 120, name: "IGNORED" },
    ]);
    expect(panel.genes).toEqual(["CFTR", "IGNORED"]);
  });

  it("matches a variant to either chromosome spelling", () => {
    const regions = parseGermlineBed("7\t99\t110\tCFTR\n").regions!;
    expect(
      variantOverlapsPanel(
        { chromosome: "chr7", position: 105, referenceAllele: "A" },
        regions
      )
    ).toBe(true);
    expect(
      variantOverlapsPanel(
        { chromosome: "chr7", position: 111, referenceAllele: "A" },
        regions
      )
    ).toBe(false);
  });
});

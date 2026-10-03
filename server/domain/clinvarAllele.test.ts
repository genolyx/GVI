import { describe, expect, it } from "vitest";
import { isPlainPathogenicCall } from "./frequencyPolicy";
import { clinvarSignificanceFromVcfLines, clinvarVariationIdFromLines, formatClnsig } from "./clinvarAllele";

describe("allele-matched ClinVar", () => {
  it("does not copy a pathogenic call from the opposite allele", () => {
    const lines = [
      "##fileformat=VCFv4.2",
      "8\t47931496\t.\tG\tGT\t.\t.\tCLNSIG=Conflicting_classifications_of_pathogenicity;CLNSIGCONF=Pathogenic_(1)|Likely_benign_(1)",
      "11\t5227002\t.\tT\tC\t.\t.\tCLNSIG=Pathogenic",
    ];
    const found = clinvarSignificanceFromVcfLines(
      lines,
      new Set(["8:47931496:GT:G", "11:5227002:T:C"])
    );
    expect(found.has("8:47931496:GT:G")).toBe(false);
    expect(found.get("11:5227002:T:C")).toBe("Pathogenic");
    expect(isPlainPathogenicCall(formatClnsig("Conflicting_classifications_of_pathogenicity"))).toBe(false);
    expect(formatClnsig("Pathogenic/Likely_pathogenic")).toBe("Pathogenic/Likely pathogenic");
  });

  it("reads a variation id only for the same ref and alt", () => {
    const lines = ["T\tC\t1493140", "AA\tA\t999", "GA\tG,C\t111"].join("\n");
    expect(clinvarVariationIdFromLines(lines, "T", "C")).toBe("1493140");
    expect(clinvarVariationIdFromLines(lines, "AA", "A")).toBe("999");
    expect(clinvarVariationIdFromLines(lines, "GA", "G")).toBeNull();
  });
});

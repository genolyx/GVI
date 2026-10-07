import { describe, expect, it } from "vitest";
import { alignForwardIndel } from "./forwardAllele";

const origin = 43124020;
const sequence = "ATGGGACACTCTAAGATTTTC";

function baseAt(site: number): string | null {
  const index = site - origin;
  if (index < 0 || index >= sequence.length) return null;
  return sequence[index] ?? null;
}

describe("forward indel alignment", () => {
  it("aligns the coding-strand BRCA1 deletion to the ClinVar allele", () => {
    expect(alignForwardIndel(43124028, "AG", "-", baseAt)).toEqual({
      position: 43124027,
      ref: "ACT",
      alt: "A",
    });
  });

  it("aligns the forward dash deletion to the same allele", () => {
    expect(alignForwardIndel(43124028, "CT", "-", baseAt)).toEqual({
      position: 43124027,
      ref: "ACT",
      alt: "A",
    });
  });

  it("leaves a left-aligned allele in place", () => {
    expect(alignForwardIndel(43124027, "ACT", "A", baseAt)).toEqual({
      position: 43124027,
      ref: "ACT",
      alt: "A",
    });
  });

  it("moves a right-shifted repeat to the ClinVar allele", () => {
    expect(alignForwardIndel(43124029, "TCT", "T", baseAt)).toEqual({
      position: 43124027,
      ref: "ACT",
      alt: "A",
    });
  });

  it("does not turn a one-base deletion into the two-base allele", () => {
    expect(alignForwardIndel(43124028, "C", "-", baseAt)).toEqual({
      position: 43124027,
      ref: "AC",
      alt: "A",
    });
  });

  it("does not rewrite a single-base change", () => {
    expect(alignForwardIndel(43124027, "A", "G", baseAt)).toBeNull();
  });

  it("does not rewrite an allele the reference cannot confirm", () => {
    expect(alignForwardIndel(43124028, "GG", "-", baseAt)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { civicVariantMatches, proteinChangeFromHgvs } from "./proteinChange";

describe("proteinChangeFromHgvs", () => {
  it("reads 1-letter and 3-letter HGVS p. forms", () => {
    expect(proteinChangeFromHgvs("p.G933V")).toBe("G933V");
    expect(proteinChangeFromHgvs("p.Gly933Val")).toBe("G933V");
    expect(proteinChangeFromHgvs("p.Val600Glu")).toBe("V600E");
    expect(proteinChangeFromHgvs("p.Arg213Ter")).toBe("R213*");
    expect(proteinChangeFromHgvs("p.R213*")).toBe("R213*");
  });

  it("returns null for missing or unparseable input", () => {
    expect(proteinChangeFromHgvs(null)).toBeNull();
    expect(proteinChangeFromHgvs("c.1799T>A")).toBeNull();
  });
});

describe("civicVariantMatches", () => {
  it("treats V600E and p.V600E as the same allele", () => {
    expect(civicVariantMatches("V600E", "V600E")).toBe(true);
    expect(civicVariantMatches("p.V600E", "V600E")).toBe(true);
    expect(civicVariantMatches("V600K", "V600E")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { hgmdPs4Check } from "./hgmdPs4";

describe("hgmdPs4Check", () => {
  it("suggests PS4 for an HGMD DM row and keeps the PMID", () => {
    const check = hgmdPs4Check(
      "HGMD: Yes - DM - Polycystic kidney disease [PMID: 27124789.0]",
      ["27124789.0", "12345678"]
    );
    expect(check?.tag).toBe("DM");
    expect(check?.pmids).toEqual(["27124789", "12345678"]);
    expect(check?.note).toContain("PMID");
    expect(check?.note).toContain("27124789");
  });

  it("suggests PS4 for a DM? row", () => {
    expect(
      hgmdPs4Check("HGMD: Yes - DM? - Bipolar disorder [PMID: 27217147]")?.tag
    ).toBe("DM?");
  });

  it("ignores polymorphism tags and a miss", () => {
    expect(hgmdPs4Check("HGMD: Yes - DP - phenotype [PMID: 1]")).toBeNull();
    expect(hgmdPs4Check("HGMD: Yes - FP - phenotype")).toBeNull();
    expect(hgmdPs4Check("HGMD: Yes - DFP - phenotype")).toBeNull();
    expect(hgmdPs4Check("HGMD: Not Found")).toBeNull();
    expect(hgmdPs4Check(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { likePattern, mapClassifiedVariant } from "./classifiedVariants";

describe("classified variant search", () => {
  it("escapes like wildcards and ignores a blank query", () => {
    expect(likePattern("  ")).toBeNull();
    expect(likePattern("CFTR")).toBe("%CFTR%");
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });

  it("marks a portal job and keeps the engine classification", () => {
    const row = mapClassifiedVariant({
      runId: 4,
      variantId: 9,
      caseId: 2,
      organizationName: "gx-portal",
      caseNumber: "abc",
      externalOrderId: "CSGX26070001",
      fromPortal: true,
      gene: "CFTR",
      hgvsC: "c.1521_1523del",
      hgvsP: "p.Phe508del",
      chromosome: "7",
      position: 117559590,
      referenceAllele: "CTT",
      alternateAllele: "C",
      institutionalLabel: "Pathogenic",
      summary: {
        classification: { label: "Likely pathogenic" },
        criteriaCodes: ["PM3", 1, "PP3"],
      },
      completedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(row.source).toBe("portal");
    expect(row.classification).toBe("Likely pathogenic");
    expect(row.criteria).toEqual(["PM3", "PP3"]);
    expect(row.institutionalLabel).toBe("Pathogenic");
  });
});

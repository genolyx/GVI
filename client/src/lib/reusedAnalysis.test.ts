import { describe, expect, it } from "vitest";
import { reusedAnalysisDescription, reusedHref } from "./reusedAnalysis";

describe("reused analysis notice", () => {
  it("points at an analysis already stored in this organization", () => {
    const notice = {
      gene: "BRCA1",
      hgvsC: "c.68_69del",
      kind: "batch" as const,
      label: "Batch Test",
      batchId: 9,
      caseId: null,
    };
    expect(reusedAnalysisDescription(notice)).toBe(
      "BRCA1 c.68_69del already has a completed analysis in batch Batch Test. This entry uses that result, so the classifier did not run again."
    );
    expect(reusedHref(notice)).toBe("/workbench/batches/9");
  });

  it("uses a shared engine analysis without opening another organization's record", () => {
    const notice = {
      gene: "BRCA1",
      hgvsC: "c.68_69del",
      kind: "shared" as const,
      label: "Shared engine analysis",
      batchId: null,
      caseId: null,
    };
    expect(reusedAnalysisDescription(notice)).toContain("completed engine analysis");
    expect(reusedAnalysisDescription(notice)).toContain("institutional call is left open");
    expect(reusedHref(notice)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { analysisReusePlace, reusedClassificationMessage } from "./curationReuse";

describe("shared engine reuse", () => {
  it("keeps a same-organization batch name", () => {
    expect(
      analysisReusePlace({
        requestOrganizationId: 1,
        source: {
          id: 40,
          organizationId: 1,
          batchId: 9,
          batchName: "Batch Test",
          caseId: null,
          caseNumber: null,
        },
      })
    ).toEqual({
      sourceRunId: 40,
      kind: "batch",
      label: "Batch Test",
      batchId: 9,
      caseId: null,
    });
  });

  it("does not name another organization's case or batch", () => {
    expect(
      analysisReusePlace({
        requestOrganizationId: 1,
        source: {
          id: 1568,
          organizationId: 51,
          batchId: 80,
          batchName: "Single variants",
          caseId: 57,
          caseNumber: "GVI-2026-0930",
        },
      })
    ).toEqual({
      sourceRunId: 1568,
      kind: "shared",
      label: "Shared engine analysis",
      batchId: null,
      caseId: null,
    });
  });

  it("leaves the institutional call open when the engine analysis came from another organization", () => {
    expect(reusedClassificationMessage(51, 1, 1568)).toBe(
      "Reused the shared engine analysis. The institutional call is left open for this organization."
    );
    expect(reusedClassificationMessage(1, 1, 40)).toBe("Reused the stored classification from run 40.");
  });
});

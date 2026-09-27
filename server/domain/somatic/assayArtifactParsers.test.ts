import { describe, expect, it } from "vitest";
import { parseAssayArtifact } from "./assayArtifactParsers";

describe("assay artifact parser", () => {
  it("parses normalized JSON findings", () => {
    expect(
      parseAssayArtifact(
        JSON.stringify([
          {
            findingType: "TMB",
            status: "detected",
            result: {
              type: "TMB",
              mutationsPerMb: 14.2,
              category: "high",
            },
            sourceRunId: "run-7",
            coverageSummaryId: 4,
          },
        ])
      )
    ).toMatchObject([
      {
        findingType: "TMB",
        status: "detected",
        sourceRunId: "run-7",
      },
    ]);
  });

  it("parses strict TSV with an embedded typed result", () => {
    const text = [
      "findingType\tstatus\tresult\tsourceRunId\tcoverageSummaryId",
      'CNV\tdetected\t{"type":"CNV","gene":"ERBB2","copyNumber":8,"call":"amplification"}\trun-8\t',
    ].join("\n");
    expect(parseAssayArtifact(text)[0]).toMatchObject({
      findingType: "CNV",
      result: { gene: "ERBB2", call: "amplification" },
    });
  });

  it("rejects mismatched or untyped detected findings", () => {
    expect(() =>
      parseAssayArtifact(
        JSON.stringify([
          {
            findingType: "MSI",
            status: "detected",
            result: null,
            sourceRunId: null,
            coverageSummaryId: null,
          },
        ])
      )
    ).toThrow(/Detected findings require/);
  });
});

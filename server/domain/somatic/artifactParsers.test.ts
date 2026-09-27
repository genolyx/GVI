import { describe, expect, it } from "vitest";
import {
  parseBedReportableRegions,
  parseCoverageArtifact,
  sha256TextArtifact,
} from "./artifactParsers";

describe("parseBedReportableRegions", () => {
  it("converts strict BED4 coordinates and preserves deterministic keys", () => {
    expect(
      parseBedReportableRegions(
        "# panel v4\nchr7\t55181377\t55181470\tEGFR:exon20\n",
        { minimumDepth: 250, minimumCoveragePercent: 95 }
      )
    ).toEqual([
      {
        regionKey: "EGFR:exon20",
        regionType: "interval",
        findingType: null,
        gene: null,
        transcript: null,
        chromosome: "7",
        start: 55181378,
        end: 55181470,
        target: {
          sourceFormat: "BED",
          sourceCoordinates: "0-based-half-open",
        },
        minimumDepth: 250,
        minimumCoveragePercent: 95,
        reportable: true,
      },
    ]);
  });

  it("rejects missing and duplicate region keys", () => {
    expect(() =>
      parseBedReportableRegions("chr7\t1\t2\n", {
        minimumDepth: null,
        minimumCoveragePercent: null,
      })
    ).toThrow(/regionKey/);
    expect(() =>
      parseBedReportableRegions("chr7\t1\t2\tR1\nchr7\t2\t3\tR1\n", {
        minimumDepth: null,
        minimumCoveragePercent: null,
      })
    ).toThrow(/Duplicate regionKey/);
  });
});

describe("parseCoverageArtifact", () => {
  it("parses strict TSV coverage records", () => {
    expect(
      parseCoverageArtifact(
        "regionKey\tmeanDepth\tcoveredPercent\nEGFR:exon20\t825\t100\n"
      )
    ).toEqual([
      {
        regionKey: "EGFR:exon20",
        meanDepth: 825,
        coveredPercent: 100,
      },
    ]);
  });

  it("parses JSON and fails closed on invalid percentages", () => {
    expect(
      parseCoverageArtifact(
        '[{"regionKey":"R1","meanDepth":120,"coveredPercent":99.5}]'
      )
    ).toHaveLength(1);
    expect(() =>
      parseCoverageArtifact(
        '[{"regionKey":"R1","meanDepth":120,"coveredPercent":101}]'
      )
    ).toThrow(/coveredPercent/);
  });
});

describe("sha256TextArtifact", () => {
  it("hashes the exact uploaded bytes represented as UTF-8 text", () => {
    expect(sha256TextArtifact("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

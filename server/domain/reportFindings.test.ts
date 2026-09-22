import { describe, expect, it } from "vitest";
import { createReportDigest } from "./reportSnapshot";
import {
  curationSnapshotEntry,
  findingsFromApproved,
  formatVariantFinding,
  stripEngineMarkup,
} from "./reportFindings";

describe("stripEngineMarkup", () => {
  it("keeps words that were separated by a break tag", () => {
    expect(stripEngineMarkup("PVS1<br>downgraded")).toBe("PVS1 downgraded");
  });

  it("returns empty for missing input", () => {
    expect(stripEngineMarkup(null)).toBe("");
    expect(stripEngineMarkup("   ")).toBe("");
  });
});

describe("formatVariantFinding", () => {
  it("leads with the reviewer classification, not the engine", () => {
    const text = formatVariantFinding({
      gene: "AMT",
      hgvsC: "c.878-1G>A",
      normalizedId: "GRCh38-3-1-C-T",
      reviewerLabel: "Pathogenic",
      engine: {
        classification: "Likely pathogenic",
        criteriaCodes: ["PVS1", "PM2"],
        clinvarSignificance: "Pathogenic",
        spliceApplicable: true,
        documentHash: "abc123def456",
        engineVersion: "v11",
        runId: 7,
      },
    });
    expect(text.startsWith("AMT c.878-1G>A: Pathogenic")).toBe(true);
    expect(text).toContain("Engine v11 suggested Likely pathogenic (PVS1, PM2).");
    expect(text).toContain("ClinVar: Pathogenic.");
    expect(text).toContain("Splicing modelled.");
    expect(text).toContain("Curation document sha256 abc123def456.");
  });

  it("still writes a line when no engine run exists", () => {
    expect(
      formatVariantFinding({
        gene: "SCN1A",
        hgvsC: "c.1A>G",
        normalizedId: "x",
        reviewerLabel: "VUS",
      })
    ).toBe("SCN1A c.1A>G: VUS");
  });
});

describe("findingsFromApproved", () => {
  it("uses the empty message when nothing is approved", () => {
    expect(findingsFromApproved([])).toContain("No approved variants");
  });

  it("separates variants with a blank line", () => {
    const text = findingsFromApproved([
      { gene: "AMT", hgvsC: "c.1A>G", normalizedId: "a", reviewerLabel: "P" },
      { gene: "NEB", hgvsC: "c.2T>C", normalizedId: "b", reviewerLabel: "LP" },
    ]);
    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("snapshot hash chain includes curation hashes", () => {
  const base = {
    schemaVersion: "1.0",
    report: { id: 1, content: { findings: "AMT c.878-1G>A: Pathogenic" } },
  };

  it("changes the digest when the curation document hash changes", () => {
    const left = createReportDigest({
      ...base,
      curation: [curationSnapshotEntry({
        gene: "AMT",
        hgvsC: "c.878-1G>A",
        normalizedId: "x",
        reviewerLabel: "P",
        engine: {
          classification: "P",
          criteriaCodes: [],
          clinvarSignificance: null,
          spliceApplicable: false,
          documentHash: "aaa",
          engineVersion: "v11",
          runId: 1,
        },
      })],
    });
    const right = createReportDigest({
      ...base,
      curation: [curationSnapshotEntry({
        gene: "AMT",
        hgvsC: "c.878-1G>A",
        normalizedId: "x",
        reviewerLabel: "P",
        engine: {
          classification: "P",
          criteriaCodes: [],
          clinvarSignificance: null,
          spliceApplicable: false,
          documentHash: "bbb",
          engineVersion: "v11",
          runId: 1,
        },
      })],
    });
    expect(left.sha256).not.toBe(right.sha256);
  });

  it("omits an entry when there is no run to point at", () => {
    expect(
      curationSnapshotEntry({
        gene: "AMT",
        hgvsC: "c.1A>G",
        normalizedId: "x",
        reviewerLabel: "VUS",
      })
    ).toBeNull();
  });
});

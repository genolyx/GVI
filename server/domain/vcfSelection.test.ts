import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import {
  emptyVcfSelectionLog,
  filterTimelineSteps,
  hpoGenesToApply,
  selectVcfRecords,
  type VcfFilterInput,
} from "./vcfSelection";

const filters: VcfFilterInput = {
  hpo: "Retinopathy",
  genes: "",
  maxAf: 0.01,
  minQual: null,
  minGenotypeQuality: null,
  minDepth: null,
  passOnly: true,
  codingOnly: true,
  excludeClinvarBenign: true,
  excludeClinvarVus: true,
};

const dropped = {
  filter: 2,
  qual: 0,
  gq: 0,
  depth: 0,
  af: 3,
  impact: 0,
  clinvar: 0,
  lab: 0,
  vus: 0,
  clinvarMix: 0,
  intron: 0,
  utr: 0,
  hpo: 0,
  panel: 0,
};

describe("empty VCF selection log", () => {
  it("lists each filter that removed records and explains a gene-less file", () => {
    const lines = emptyVcfSelectionLog({
      parsedCount: 5,
      truncated: false,
      dropped,
      filters,
      geneCount: 12,
      recordsWithoutGene: 5,
      afFromInfoOnly: 5,
    });
    expect(lines).toEqual([
      "Read 5 variant records.",
      "2 removed because FILTER was not PASS.",
      "3 removed because allele frequency was above 0.01.",
      "Allele frequency came from the VCF INFO AF field because gnomAD_AF and POP_AF were absent. INFO AF is often the sample allele fraction, not a population frequency.",
      "None of these records include a gene symbol, so the HPO list (12 genes) cannot match a variant. The VCF needs a gene annotation such as GENE, SYMBOL, or SnpEff ANN.",
      "Nothing was kept.",
    ]);
  });

  it("notes the ingest cap and skips the gene note when symbols are present", () => {
    const lines = emptyVcfSelectionLog({
      parsedCount: 200000,
      truncated: true,
      dropped: { ...dropped, filter: 0, af: 0, hpo: 200000 },
      filters,
      geneCount: 4,
      recordsWithoutGene: 10,
      afFromInfoOnly: 0,
    });
    expect(lines[0]).toBe(
      "Read the first 200,000 variant records. Ingest stops at that limit."
    );
    expect(lines).toContain(
      "200,000 removed because the gene was missing or outside the HPO list."
    );
    expect(lines.some(line => line.includes("INFO AF"))).toBe(false);
    expect(lines.some(line => line.includes("gene symbol"))).toBe(false);
  });
});

describe("VCF frequency and HPO applicability", () => {
  it("reads every variant record", () => {
    const rows = ["#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO"];
    for (let position = 1; position <= 50_001; position += 1) {
      rows.push(`1\t${position}\t.\tA\tG\t.\tPASS\t.`);
    }
    expect(parseVcf(rows.join("\n"), "GRCh38")).toHaveLength(50_001);
  });

  it("keeps sample INFO AF out of the population frequency", () => {
    const parsed = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "1\t100\t.\tA\tG\t50\tPASS\tAF=0.5\tGT\t0/1",
        "1\t200\t.\tA\tG\t50\tPASS\tgnomAD_AF=0.001;AF=0.5\tGT\t0/1",
      ].join("\n"),
      "GRCh38"
    );
    expect(parsed[0].populationAf).toBeNull();
    expect(parsed[1].populationAf).toBe("0.001");
  });

  it("applies gnomAD before the HPO gene list", () => {
    expect(
      filterTimelineSteps({
        total: 100,
        dropped: {
          filter: 10,
          qual: 0,
          gq: 0,
          depth: 0,
          af: 30,
          impact: 20,
          clinvar: 5,
          lab: 0,
          vus: 0,
          clinvarMix: 0,
          intron: 0,
          utr: 0,
          hpo: 25,
          panel: 0,
        },
        filters: {
          hpo: "Retinopathy",
          genes: "",
          maxAf: 0.01,
          minQual: null,
          minGenotypeQuality: null,
          minDepth: null,
          passOnly: true,
          codingOnly: true,
          excludeClinvarBenign: true,
          excludeClinvarVus: true,
        },
        hpoApplied: true,
        hpoGeneCount: 458,
        panelApplied: false,
      }).map(step => `${step.label} | ${step.remaining}`)
    ).toEqual([
      "FILTER is PASS | 90",
      "gnomAD allele frequency is at most 0.01 | 60",
      "ClinVar VUS is removed | 60",
      "ClinVar benign is removed when non-coding or homozygous | 55",
      "Benign or likely benign from a major laboratory | 55",
      "Intronic variant is ClinVar pathogenic or likely pathogenic | 55",
      "UTR variant is ClinVar pathogenic or likely pathogenic | 55",
      "Consequence is HIGH or MODERATE | 35",
      "Gene is in the HPO list (458 genes) | 10",
    ]);
  });

  it("does not apply an HPO gene list when every record lacks a gene", () => {
    expect(hpoGenesToApply(new Set(["TP53"]), 10, 10)).toBeNull();
    expect(hpoGenesToApply(new Set(["TP53"]), 10, 2)).toEqual(new Set(["TP53"]));
    expect(hpoGenesToApply(null, 10, 10)).toBeNull();
  });
});

const header = "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO";

describe("local gnomAD fallback", () => {
  const openFilters: VcfFilterInput = {
    hpo: "",
    genes: "",
    maxAf: 0.01,
    minQual: null,
    minGenotypeQuality: null,
    minDepth: null,
    passOnly: false,
    codingOnly: false,
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
  };

  it("drops a blank VCF frequency when the local file is above the maximum and keeps the rare one", async () => {
    const selection = await selectVcfRecords(
      [
        header,
        "8\t10610142\t.\tG\tC\t50\tPASS\tAF=1",
        "8\t200\t.\tA\tG\t50\tPASS\tAF=1",
      ].join("\n"),
      "GRCh38",
      openFilters,
      null,
      async () =>
        new Map([
          ["8:10610142:G:C", 0.407027],
          ["8:200:A:G", 0.0001],
        ]),
      new Set(),
      null
    );
    expect(selection.filtered.kept.map(variant => variant.position)).toEqual([200]);
    expect(selection.filtered.kept[0]?.populationAf).toBe("0.0001");
    expect(selection.filtered.dropped.af).toBe(1);
    expect(selection.gnomadFilled).toBe(true);
    expect(selection.notes[0]).toContain("local gnomAD file");
  });

  it("keeps a site the local file does not contain", async () => {
    const selection = await selectVcfRecords(
      [header, "8\t200\t.\tA\tG\t50\tPASS\tAF=1"].join("\n"),
      "GRCh38",
      openFilters,
      null,
      async () => new Map([["8:200:A:G", 0]]),
      new Set(),
      null
    );
    expect(selection.filtered.kept).toHaveLength(1);
    expect(selection.filtered.kept[0]?.populationAf).toBe("0");
  });

  it("uses the VCF frequency and does not ask the local file", async () => {
    let called = false;
    const selection = await selectVcfRecords(
      [header, "8\t100\t.\tA\tG\t50\tPASS\tgnomAD_AF=0.5"].join("\n"),
      "GRCh38",
      openFilters,
      null,
      async () => {
        called = true;
        return new Map();
      },
      new Set(),
      null
    );
    expect(called).toBe(false);
    expect(selection.filtered.kept).toHaveLength(0);
    expect(selection.filtered.dropped.af).toBe(1);
  });
});

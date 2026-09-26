import { parseGeneList } from "@shared/geneList";
import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import { applyVcfFilters } from "./vcfFilter";

const VCF = [
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
  "17\t7675088\t.\tC\tT\t80\tPASS\tGENE=TP53;HGVSC=c.524G>A;gnomAD_AF=0.00001;IMPACT=MODERATE\tGT:DP:GQ\t0/1:40:50",
  "1\t100\t.\tA\tG\t8\tLowQual\tGENE=SCN1A;HGVSC=c.1A>G;gnomAD_AF=0.2;IMPACT=LOW\tGT:DP:GQ\t0/1:4:10",
  "2\t200\t.\tA\tT\t90\tPASS\tGENE=BRCA1;HGVSC=NM_007294.4:c.68_69del;gnomAD_AF=0.0002;IMPACT=HIGH\tGT:DP:GQ\t0/1:30:40",
  "3\t300\t.\tG\tA\t90\tPASS\tGENE=TTN;HGVSC=c.1G>A;IMPACT=MODIFIER\tGT:DP:GQ\t0/1:30:40",
].join("\n");

describe("VCF workbench filters", () => {
  const parsed = parseVcf(VCF, "GRCh38");

  it("reads QUAL, GQ, and the FILTER column", () => {
    expect(parsed[0]).toMatchObject({ siteQuality: 80, genotypeQuality: 50, callFilter: "PASS", gene: "TP53" });
    expect(parsed[1]).toMatchObject({ siteQuality: 8, genotypeQuality: 10, callFilter: "LowQual" });
  });

  it("keeps rare PASS coding variants in the HPO gene set", () => {
    const result = applyVcfFilters(parsed, {
      genes: new Set(["TP53", "BRCA1"]),
      maxAf: 0.01,
      minQual: 30,
      minGenotypeQuality: 20,
      minDepth: 10,
      passOnly: true,
      codingOnly: true,
    });
    expect(result.classifiable.map(row => `${row.gene} ${row.hgvsC}`)).toEqual([
      "TP53 c.524G>A",
      "BRCA1 c.68_69del",
    ]);
    expect(result.dropped).toMatchObject({ filter: 1, qual: 0, af: 0, impact: 1, hpo: 0 });
  });

  it("does not drop a variant whose frequency or quality is missing", () => {
    const result = applyVcfFilters(
      [{
        gene: "TP53",
        transcript: null,
        hgvsC: "c.524G>A",
        hgvsP: null,
        populationAf: null,
        readDepth: null,
        impact: "UNKNOWN",
        siteQuality: null,
        genotypeQuality: null,
        callFilter: null,
      }],
      {
        genes: new Set(["TP53"]),
        maxAf: 0.01,
        minQual: 30,
        minGenotypeQuality: 20,
        minDepth: 10,
        passOnly: true,
        codingOnly: true,
      },
    );
    expect(result.classifiable).toHaveLength(1);
  });

  it("keeps only genes on the panel list", () => {
    const result = applyVcfFilters(parsed, {
      genes: new Set(["TP53", "BRCA1"]),
      panelGenes: new Set(["TP53"]),
      maxAf: 0.01,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
    });
    expect(result.classifiable.map(row => row.gene)).toEqual(["TP53"]);
    expect(result.dropped.panel).toBe(1);
  });

  it("reads a panel file and a comma-separated list as gene symbols", () => {
    expect(parseGeneList("SCN1A, KCNQ2\nSTXBP1")).toEqual(new Set(["SCN1A", "KCNQ2", "STXBP1"]));
    expect(parseGeneList("gene\ttranscript\nBRCA1\tNM_007294.4\nNKX2-1\tNM_001079668.3")).toEqual(new Set(["BRCA1", "NKX2-1"]));
    expect(parseGeneList("   ")).toBeNull();
  });
});

import { parseGeneList } from "@shared/geneList";
import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import { applyVcfFilters, isClinvarBenignCall, isClinvarBenignVusMix, isClinvarVusCall } from "./vcfFilter";

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
      excludeClinvarBenign: true,
      excludeClinvarVus: true,
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
        excludeClinvarBenign: true,
        excludeClinvarVus: true,
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
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
    });
    expect(result.classifiable.map(row => row.gene)).toEqual(["TP53"]);
    expect(result.dropped.panel).toBe(1);
  });

  it("keeps a coordinate overlap when the gene is not on the panel list", () => {
    const result = applyVcfFilters(parsed, {
      genes: null,
      panelGenes: new Set(["TP53"]),
      panelRegions: [{ chromosome: "chr2", start: 190, end: 210 }],
      maxAf: null,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
    });
    expect(result.kept.map(row => row.gene).sort()).toEqual(["BRCA1", "TP53"]);
  });

  it("drops ClinVar Benign, Likely benign, and Benign/Likely benign before classification", () => {
    expect(isClinvarBenignCall("Benign")).toBe(true);
    expect(isClinvarBenignCall("Likely_benign")).toBe(true);
    expect(isClinvarBenignCall("Benign/Likely benign")).toBe(true);
    expect(isClinvarBenignCall("Benign&Likely_benign")).toBe(true);
    expect(isClinvarBenignCall("Pathogenic")).toBe(false);
    expect(isClinvarBenignCall("Likely pathogenic")).toBe(false);
    expect(isClinvarBenignCall("Uncertain significance")).toBe(false);
    expect(isClinvarBenignCall("Conflicting interpretations of pathogenicity")).toBe(false);
    expect(isClinvarBenignCall("Benign/Likely pathogenic")).toBe(false);
    expect(isClinvarBenignCall(null)).toBe(false);
    expect(isClinvarVusCall("Uncertain significance")).toBe(true);
    expect(isClinvarVusCall("Uncertain_significance")).toBe(true);
    expect(isClinvarVusCall("VUS")).toBe(true);
    expect(isClinvarVusCall("Pathogenic")).toBe(false);
    expect(isClinvarVusCall("Benign")).toBe(false);
    expect(isClinvarVusCall("Conflicting interpretations of pathogenicity")).toBe(false);
    expect(isClinvarVusCall("Uncertain significance/Likely pathogenic")).toBe(false);
    expect(isClinvarVusCall(null)).toBe(false);
    expect(isClinvarBenignVusMix("Uncertain significance/Likely benign")).toBe(true);
    expect(isClinvarBenignVusMix("VUS&Likely_benign")).toBe(true);
    expect(isClinvarBenignVusMix("Benign")).toBe(false);
    expect(isClinvarBenignVusMix("Uncertain significance")).toBe(false);
    expect(isClinvarBenignVusMix("Uncertain significance/Likely pathogenic")).toBe(false);
    expect(isClinvarBenignVusMix("Benign/Likely pathogenic")).toBe(false);

    const result = applyVcfFilters(
      [
        { ...parsed[0], clinvarSignificance: "Benign" },
        { ...parsed[2], clinvarSignificance: "Benign/Likely benign" },
        { ...parsed[0], gene: "SCN1A", hgvsC: "c.2A>G", clinvarSignificance: "Pathogenic" },
        { ...parsed[0], gene: "KCNQ2", hgvsC: "c.3A>G", clinvarSignificance: null },
        { ...parsed[0], gene: "TULP1", hgvsC: "c.4A>G", clinvarSignificance: "Uncertain significance" },
        { ...parsed[0], gene: "RP1", hgvsC: "c.5A>G", clinvarSignificance: "Uncertain significance/Likely benign" },
        { ...parsed[0], gene: "ABCA4", hgvsC: "c.6A>G", clinvarSignificance: "Benign/Likely pathogenic" },
      ],
      {
        genes: null,
        maxAf: null,
        minQual: null,
        minGenotypeQuality: null,
        minDepth: null,
        passOnly: false,
        codingOnly: false,
        excludeClinvarBenign: true,
        excludeClinvarVus: true,
      }
    );
    expect(result.kept.map(row => row.gene)).toEqual(["SCN1A", "KCNQ2", "ABCA4"]);
    expect(result.classifiable.map(row => row.gene)).toEqual(["SCN1A", "KCNQ2", "ABCA4"]);
    expect(result.dropped.clinvar).toBe(2);
    expect(result.dropped.vus).toBe(1);
    expect(result.dropped.clinvarMix).toBe(1);

    const benignOnly = applyVcfFilters(
      [{ ...parsed[0], clinvarSignificance: "Uncertain significance/Likely benign" }],
      {
        genes: null,
        maxAf: null,
        minQual: null,
        minGenotypeQuality: null,
        minDepth: null,
        passOnly: false,
        codingOnly: false,
        excludeClinvarBenign: true,
        excludeClinvarVus: false,
      }
    );
    expect(benignOnly.kept).toHaveLength(1);
    expect(benignOnly.dropped.clinvarMix).toBe(0);
  });

  it("reads a panel file and a comma-separated list as gene symbols", () => {
    expect(parseGeneList("SCN1A, KCNQ2\nSTXBP1")).toEqual(new Set(["SCN1A", "KCNQ2", "STXBP1"]));
    expect(parseGeneList("gene\ttranscript\nBRCA1\tNM_007294.4\nNKX2-1\tNM_001079668.3")).toEqual(new Set(["BRCA1", "NKX2-1"]));
    expect(parseGeneList("   ")).toBeNull();
  });
});

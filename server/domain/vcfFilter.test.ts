import { geneListCode, parseGeneList } from "@shared/geneList";
import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import {
  applyVcfFilters,
  isClinvarBenignCall,
  isClinvarBenignVusMix,
  isClinvarVusCall,
  isHomozygousGenotype,
  fivePrimeStartDistance,
  nearestIntronOffset,
} from "./vcfFilter";

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

  it("keeps opted-in ACMG secondary finding genes that are off the selected list", () => {
    const site = (
      gene: string,
      populationAf: string,
      clinvarSignificance: string
    ) => ({
      gene,
      transcript: null,
      hgvsC: "c.1A>G",
      hgvsP: null,
      populationAf,
      readDepth: 30,
      impact: "MODERATE",
      siteQuality: 80,
      genotypeQuality: 40,
      callFilter: "PASS",
      clinvarSignificance,
    });
    const rows = [
      site("HBB", "0.0001", "Pathogenic"),
      site("BRCA1", "0.0001", "Pathogenic"),
      site("SCN1A", "0.0001", "Pathogenic"),
      site("LDLR", "0.0001", "Uncertain significance"),
      site("PALB2", "0.04", "Pathogenic"),
    ];
    const filters = {
      genes: null,
      panelGenes: new Set(["HBB"]),
      maxAf: 0.001,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
    };
    const closed = applyVcfFilters(rows, filters);
    expect(closed.kept.map(row => row.gene)).toEqual(["HBB"]);
    const opened = applyVcfFilters(rows, { ...filters, secondaryFindings: true });
    expect(opened.kept.map(row => row.gene).sort()).toEqual(["BRCA1", "HBB", "PALB2"]);
    expect(opened.dropped.panel).toBe(1);
    expect(opened.dropped.vus).toBe(1);
    expect(opened.dropped.af).toBe(0);
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

  it("keeps ClinVar benign calls under the limit and removes a carrier VUS", () => {
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
    expect(result.kept.map(row => row.gene)).toEqual([
      "TP53",
      "BRCA1",
      "SCN1A",
      "KCNQ2",
      "RP1",
      "ABCA4",
    ]);
    expect(result.dropped.clinvar).toBe(0);
    expect(result.dropped.vus).toBe(1);
    expect(result.dropped.clinvarMix).toBe(0);

    const rareDisease = applyVcfFilters(
      [{ ...parsed[0], clinvarSignificance: "Uncertain significance" }],
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
        track: "rare_disease",
      }
    );
    expect(rareDisease.kept).toHaveLength(1);
  });

  it("drops a non-coding ClinVar benign call and a homozygous benign call", () => {
    expect(isHomozygousGenotype("1/1")).toBe(true);
    expect(isHomozygousGenotype("1|1")).toBe(true);
    expect(isHomozygousGenotype("0/1")).toBe(false);
    expect(isHomozygousGenotype("1/0")).toBe(false);
    expect(isHomozygousGenotype("1")).toBe(false);

    const benignFilters = {
      genes: null,
      maxAf: null,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
    };
    const rows = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "17\t100\t.\tC\tT\t80\tPASS\tGENE=TP53;HGVSC=c.100-50C>T;IMPACT=MODIFIER;CONSEQUENCE=intron_variant;CLNSIG=Benign\tGT:DP:GQ\t0/1:40:50",
        "17\t200\t.\tC\tT\t80\tPASS\tGENE=TP53;HGVSC=c.524G>A;IMPACT=MODERATE;CLNSIG=Benign\tGT:DP:GQ\t0/1:40:50",
        "17\t300\t.\tC\tT\t80\tPASS\tGENE=BRCA1;HGVSC=c.68_69del;IMPACT=HIGH;CLNSIG=Likely_benign\tGT:DP:GQ\t1/1:40:50",
        "17\t400\t.\tC\tT\t80\tPASS\tGENE=BRCA1;HGVSC=c.200-5C>T;IMPACT=MODIFIER;CLNSIG=Pathogenic\tGT:DP:GQ\t0/1:40:50",
        "1\t500\t.\tA\tG\t80\tPASS\tGENE=HBB;HGVSC=c.20A>T;IMPACT=MODERATE;CLNSIG=Benign\tGT:DP:GQ\t1/0:40:50",
        "2\t600\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.1-10A>G;IMPACT=MODIFIER;CONSEQUENCE=intron_variant;CLNSIG=Benign\tGT:DP:GQ\t0/1:40:50",
      ].join("\n"),
      "GRCh38"
    );
    const result = applyVcfFilters(rows, benignFilters);
    expect(result.kept.map(row => row.hgvsC)).toEqual([
      "c.524G>A",
      "c.200-5C>T",
      "c.20A>T",
    ]);
    expect(result.dropped.clinvar).toBe(3);

    const untyped = applyVcfFilters([rows[0]], { ...benignFilters, track: "none" });
    expect(untyped.kept).toHaveLength(1);
    expect(untyped.dropped.clinvar).toBe(0);
  });

  it("keeps an intronic variant within 20 bp and drops a deeper one", () => {
    expect(nearestIntronOffset("c.200-2G>A")).toBe(2);
    expect(nearestIntronOffset("NM_000492.4:c.1066-11A>G")).toBe(11);
    expect(nearestIntronOffset("c.1056+347805G>A")).toBe(347805);
    expect(nearestIntronOffset("c.463+128_463+129insAGT")).toBe(128);
    expect(nearestIntronOffset("c.1177+109_1178-99del")).toBeNull();
    expect(nearestIntronOffset("c.524G>A")).toBeNull();

    const filters = {
      genes: null,
      maxAf: null,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
      inheritance: new Map([["CFTR", "AR"]]),
    };
    const rows = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "7\t100\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.200-2G>A;IMPACT=HIGH;CONSEQUENCE=splice_acceptor_variant&intron_variant\tGT\t0/1",
        "7\t200\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.1066-11A>G;IMPACT=LOW;CONSEQUENCE=splice_region_variant&intron_variant\tGT\t0/1",
        "7\t300\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.1066-21A>G;IMPACT=MODIFIER;CONSEQUENCE=intron_variant\tGT\t0/1",
        "7\t400\t.\tG\tA\t80\tPASS\tGENE=CFTR;HGVSC=c.3718-2477C>T;IMPACT=MODIFIER;CONSEQUENCE=intron_variant;CLNSIG=Pathogenic\tGT\t0/1",
        "7\t500\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.1177+109_1178-99del;IMPACT=MODIFIER;CONSEQUENCE=intron_variant\tGT\t0/1",
        "16\t600\t.\tG\tA\t80\tPASS\tGENE=WWOX;HGVSC=c.1056+347805G>A;IMPACT=MODIFIER;CONSEQUENCE=intron_variant\tGT\t0/1",
      ].join("\n"),
      "GRCh38"
    );
    const result = applyVcfFilters(rows, filters);
    expect(result.kept.map(row => row.hgvsC)).toEqual(["c.3718-2477C>T"]);
    expect(result.dropped.intron).toBe(5);

    const rareDisease = applyVcfFilters(rows, { ...filters, track: "rare_disease" });
    expect(rareDisease.kept.map(row => row.hgvsC)).toEqual([
      "c.200-2G>A",
      "c.1066-11A>G",
      "c.3718-2477C>T",
      "c.1177+109_1178-99del",
    ]);
    expect(rareDisease.dropped.intron).toBe(2);

    const untyped = applyVcfFilters([rows[5]], { ...filters, track: "none" });
    expect(untyped.kept).toHaveLength(1);
  });

  it("keeps a 5' UTR variant next to the start codon and drops the rest of the UTR", () => {
    expect(fivePrimeStartDistance("c.-3A>G")).toBe(3);
    expect(fivePrimeStartDistance("c.-7_1del")).toBe(0);
    expect(fivePrimeStartDistance("c.-9_-8insAGGAGG")).toBe(8);
    expect(fivePrimeStartDistance("c.-20C>G")).toBe(20);
    expect(fivePrimeStartDistance("c.*10A>G")).toBeNull();
    expect(fivePrimeStartDistance("c.1A>G")).toBeNull();

    const filters = {
      genes: null,
      maxAf: null,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
      inheritance: new Map([["CFTR", "AR"]]),
    };
    const rows = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "1\t100\t.\tA\tG\t80\tPASS\tGENE=H6PD;HGVSC=c.-7_1del;IMPACT=HIGH;CONSEQUENCE=splice_acceptor_variant&5_prime_UTR_variant&intron_variant\tGT\t0/1",
        "1\t200\t.\tG\tA\t80\tPASS\tGENE=MLYCD;HGVSC=c.-7G>A;IMPACT=MODIFIER;CONSEQUENCE=5_prime_UTR_variant\tGT\t0/1",
        "1\t300\t.\tC\tG\t80\tPASS\tGENE=PEX5;HGVSC=c.-20C>G;IMPACT=MODIFIER;CONSEQUENCE=5_prime_UTR_variant\tGT\t0/1",
        "1\t400\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.*10A>G;IMPACT=MODIFIER;CONSEQUENCE=3_prime_UTR_variant;CLNSIG=Pathogenic\tGT\t0/1",
        "1\t500\t.\tA\tG\t80\tPASS\tGENE=TTN;HGVSC=c.*50A>G;IMPACT=MODIFIER;CONSEQUENCE=3_prime_UTR_variant\tGT\t0/1",
        "1\t600\t.\tA\tG\t80\tPASS\tGENE=TTN;HGVSC=c.-200A>G;IMPACT=MODIFIER;CONSEQUENCE=upstream_gene_variant\tGT\t0/1",
        "1\t700\t.\tA\tT\t80\tPASS\tGENE=GAA;HGVSC=c.1A>T;IMPACT=HIGH;CONSEQUENCE=start_lost\tGT\t0/1",
      ].join("\n"),
      "GRCh38"
    );
    const result = applyVcfFilters(rows, filters);
    expect(result.kept.map(row => row.hgvsC)).toEqual(["c.*10A>G", "c.1A>T"]);
    expect(result.dropped.intron).toBe(1);
    expect(result.dropped.utr).toBe(4);

    const rareDisease = applyVcfFilters(rows, { ...filters, track: "rare_disease" });
    expect(rareDisease.kept.map(row => row.hgvsC)).toEqual([
      "c.-7_1del",
      "c.-7G>A",
      "c.*10A>G",
      "c.1A>T",
    ]);

    const untyped = applyVcfFilters([rows[4]], { ...filters, track: "none" });
    expect(untyped.kept).toHaveLength(1);
  });

  it("drops a coding variant a major laboratory called benign", () => {
    const rows = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "11\t5227002\t.\tT\tC\t80\tPASS\tGENE=HBB;HGVSC=c.20A>T;IMPACT=MODERATE\tGT\t0/1",
      ].join("\n"),
      "GRCh38"
    );
    const filters = {
      genes: null,
      maxAf: null,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
      majorLabBenign: new Set(["11:5227002:T:C"]),
    };
    const result = applyVcfFilters(rows, filters);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.lab).toBe(1);

    const untyped = applyVcfFilters(rows, { ...filters, track: "none" });
    expect(untyped.kept).toHaveLength(1);
    expect(untyped.dropped.lab).toBe(0);
  });

  it("keeps a common pathogenic allele and a low-penetrance pathogenic allele above the frequency limit", () => {
    const inheritance = new Map([["HBB", "AR"], ["HFE", "AR"]]);
    const filters = {
      genes: null,
      maxAf: 0.001,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
      inheritance,
    };
    const result = applyVcfFilters(
      [
        {
          ...parsed[0],
          gene: "HBB",
          hgvsC: "c.20A>T",
          hgvsP: "p.Glu7Val",
          populationAf: "0.05",
          clinvarSignificance: "Pathogenic",
        },
        {
          ...parsed[0],
          gene: "HFE",
          hgvsC: "c.845G>A",
          hgvsP: "p.Cys282Tyr",
          populationAf: "0.06",
          clinvarSignificance: "Pathogenic/Pathogenic, low penetrance",
        },
        {
          ...parsed[0],
          gene: "HFE",
          hgvsC: "c.187C>G",
          hgvsP: "p.His63Asp",
          populationAf: "0.0002",
          clinvarSignificance: "Pathogenic",
        },
      ],
      filters
    );
    expect(result.kept.map(row => row.hgvsC)).toEqual(["c.20A>T", "c.845G>A", "c.187C>G"]);
    expect(result.dropped.af).toBe(0);
  });

  it("uses only frequency and quality when no test type is selected", () => {
    const result = applyVcfFilters(
      [
        {
          ...parsed[0],
          gene: "HBB",
          hgvsC: "c.20A>T",
          populationAf: "0.05",
          clinvarSignificance: "Pathogenic",
        },
        {
          ...parsed[0],
          gene: "TULP1",
          hgvsC: "c.4A>G",
          populationAf: "0.0001",
          clinvarSignificance: "Uncertain significance",
        },
      ],
      {
        genes: null,
        maxAf: 0.001,
        minQual: null,
        minGenotypeQuality: null,
        minDepth: null,
        passOnly: false,
        codingOnly: false,
        excludeClinvarBenign: false,
        excludeClinvarVus: false,
        track: "none",
        inheritance: new Map([["HBB", "AR"]]),
      }
    );
    expect(result.kept.map(row => row.gene)).toEqual(["TULP1"]);
    expect(result.dropped.af).toBe(1);
    expect(result.dropped.vus).toBe(0);
  });

  it("holds a coding ClinVar VUS or homozygous benign call and leaves deep introns out", () => {
    const filters = {
      genes: null,
      panelGenes: new Set(["TP53", "BRCA1"]),
      maxAf: 0.001,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "carrier" as const,
      majorLabBenign: new Set(["17:400:C:T"]),
    };
    const rows = parseVcf(
      [
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
        "17\t100\t.\tC\tT\t80\tPASS\tGENE=TP53;HGVSC=c.524G>A;IMPACT=MODERATE;gnomAD_AF=0.0001;CLNSIG=Uncertain_significance\tGT:DP:GQ\t0/1:40:50",
        "17\t200\t.\tC\tT\t80\tPASS\tGENE=BRCA1;HGVSC=c.68_69del;IMPACT=HIGH;gnomAD_AF=0.0001;CLNSIG=Likely_benign\tGT:DP:GQ\t1/1:40:50",
        "17\t300\t.\tC\tT\t80\tPASS\tGENE=TP53;HGVSC=c.100-400C>T;IMPACT=MODIFIER;CONSEQUENCE=intron_variant;gnomAD_AF=0.0001;CLNSIG=Uncertain_significance\tGT:DP:GQ\t0/1:40:50",
        "17\t400\t.\tC\tT\t80\tPASS\tGENE=BRCA1;HGVSC=c.5266dup;IMPACT=HIGH;gnomAD_AF=0.0001;CLNSIG=Benign\tGT:DP:GQ\t0/1:40:50",
        "1\t500\t.\tA\tG\t80\tPASS\tGENE=CFTR;HGVSC=c.1521_1523del;IMPACT=MODERATE;gnomAD_AF=0.0001;CLNSIG=Uncertain_significance\tGT:DP:GQ\t0/1:40:50",
      ].join("\n"),
      "GRCh38"
    );
    const result = applyVcfFilters(rows, filters);
    expect(result.held.map(item => `${item.reason} ${item.variant.hgvsC}`)).toEqual([
      "vus c.524G>A",
      "benign c.68_69del",
      "lab c.5266dup",
    ]);
    expect(result.kept).toHaveLength(0);

    const rareDisease = applyVcfFilters(rows, { ...filters, track: "rare_disease" });
    expect(rareDisease.kept.map(row => row.hgvsC)).toEqual(["c.524G>A"]);
    expect(rareDisease.held.map(item => `${item.reason} ${item.variant.hgvsC}`)).toEqual([
      "benign c.68_69del",
      "benign c.5266dup",
    ]);
    const cancer = applyVcfFilters(
      [{ ...rows[0], clinvarSignificance: "Uncertain significance" }],
      { ...filters, track: "hereditary_cancer", majorLabBenign: new Set() }
    );
    expect(cancer.kept).toHaveLength(1);
    expect(cancer.held).toHaveLength(0);
  });

  it("keeps only ClinVar pathogenic and likely pathogenic calls on the health screen", () => {
    const filters = {
      genes: null,
      maxAf: 0.001,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: false,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
      track: "health_screen" as const,
      majorLabBenign: new Set(["17:400:C:T"]),
    };
    const row = (patch: Partial<(typeof parsed)[number]>) => ({ ...parsed[0], ...patch });
    const result = applyVcfFilters(
      [
        row({
          hgvsC: "c.20A>T",
          populationAf: "0.08",
          clinvarSignificance: "Pathogenic",
          consequence: "intron_variant",
          impact: "MODIFIER",
        }),
        row({
          hgvsC: "c.109G>A",
          populationAf: "0.04",
          clinvarSignificance: "Likely pathogenic",
        }),
        row({
          hgvsC: "c.845G>A",
          populationAf: "0.06",
          clinvarSignificance: "Pathogenic, low penetrance",
        }),
        row({
          hgvsC: "c.524G>A",
          populationAf: "0.00001",
          clinvarSignificance: "Uncertain significance",
        }),
        row({
          hgvsC: "c.68_69del",
          populationAf: "0.00001",
          clinvarSignificance: "Benign",
        }),
        row({
          position: 400,
          hgvsC: "c.5266dup",
          populationAf: "0.00001",
          clinvarSignificance: "Pathogenic",
        }),
        row({
          hgvsC: "c.1A>G",
          populationAf: "0.00001",
          clinvarSignificance: null,
        }),
      ],
      filters
    );
    expect(result.kept.map(item => item.hgvsC)).toEqual(["c.20A>T", "c.109G>A", "c.845G>A", "c.5266dup"]);
    expect(result.held).toHaveLength(0);
    expect(result.dropped.clinvar).toBe(3);
    expect(result.dropped.af).toBe(0);
  });

  it("reads a panel file and a comma-separated list as gene symbols", () => {
    expect(parseGeneList("SCN1A, KCNQ2\nSTXBP1")).toEqual(new Set(["SCN1A", "KCNQ2", "STXBP1"]));
    expect(parseGeneList("gene\ttranscript\nBRCA1\tNM_007294.4\nNKX2-1\tNM_001079668.3")).toEqual(new Set(["BRCA1", "NKX2-1"]));
    expect(parseGeneList("   ")).toBeNull();
  });

  it("builds a portal panel code from the gene list name", () => {
    expect(geneListCode("Carrier 2000+", new Set())).toBe("carrier-2000");
    expect(geneListCode("Carrier 2000+", new Set(["carrier-2000"]))).toBe("carrier-2000-2");
    expect(geneListCode("유전자", new Set())).toBe("genes");
  });
});

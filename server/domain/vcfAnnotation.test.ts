import { describe, expect, it } from "vitest";
import { parseVcf } from "./vcf";
import { inspectVcfAnnotation } from "./vcfAnnotation";
import { annotatedVcfFileName, buildAnnotationCommand, VcfAnnotationFailure } from "./vepAnnotate";

const VEP_FORMAT =
  "Allele|Consequence|IMPACT|SYMBOL|Gene|Feature|HGVSc|HGVSp|MANE_SELECT|CANONICAL|gnomADe_AF|gnomADg_AF|CLIN_SIG";

const VEP_HEADER = `##INFO=<ID=CSQ,Number=.,Type=String,Description="Consequence annotations from Ensembl VEP. Format: ${VEP_FORMAT}">`;

const RAW = ["##fileformat=VCFv4.2", "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO", "1\t100\t.\tA\tG\t.\tPASS\t."].join(
  "\n"
);

describe("VCF annotation detection", () => {
  it("queues annotation when the header has neither CSQ nor ANN", () => {
    expect(inspectVcfAnnotation(RAW)).toEqual({ action: "annotate", source: null, fields: [] });
  });

  it("skips VEP when the required columns are present", () => {
    const decision = inspectVcfAnnotation(VEP_HEADER);
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") return;
    expect(decision.source).toBe("vep");
    expect(decision.columns).toEqual(
      expect.arrayContaining(["SYMBOL", "Consequence", "IMPACT", "gnomADe_AF", "gnomADg_AF"])
    );
  });

  it("rejects an annotated VEP file that has no gnomAD column", () => {
    const header =
      '##INFO=<ID=CSQ,Number=.,Type=String,Description="Format: Allele|Consequence|IMPACT|SYMBOL">';
    const decision = inspectVcfAnnotation(header);
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") return;
    expect(decision.missing).toContain("gnomADe_AF or gnomADg_AF");
  });

  it("skips snpEff when gene, effect, and impact columns are present", () => {
    const header =
      '##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations. Format: Allele|Annotation|Annotation_Impact|Gene_Name|Feature_ID|HGVS.c|HGVS.p">';
    expect(inspectVcfAnnotation(header).action).toBe("skip");
  });

  it("reads gene, consequence, and the higher gnomAD frequency from CSQ", () => {
    const vcf = [
      "##fileformat=VCFv4.2",
      VEP_HEADER,
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
      [
        "17",
        "7675088",
        ".",
        "C",
        "T",
        "80",
        "PASS",
        "CSQ=T|missense_variant|MODERATE|OTHER|ENSG1|ENST1|c.1C>T|p.Arg1Cys||YES|0.01|0.0002|," +
          "T|missense_variant|MODERATE|TP53|ENSG2|ENST2|c.524G>A|p.Arg175His|NM_000546.6|YES|0.00001|0.0004|Pathogenic",
      ].join("\t"),
    ].join("\n");
    expect(parseVcf(vcf, "GRCh38")[0]).toMatchObject({
      gene: "TP53",
      transcript: "NM_000546.6",
      hgvsC: "c.524G>A",
      hgvsP: "p.Arg175His",
      consequence: "missense_variant",
      impact: "MODERATE",
      populationAf: "0.0004",
      clinvarSignificance: "Pathogenic",
    });
  });

  it("stores the MANE RefSeq accession and drops the Ensembl prefix from HGVSc", () => {
    const vcf = [
      "##fileformat=VCFv4.2",
      VEP_HEADER,
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
      [
        "6",
        "35471221",
        ".",
        "C",
        "T",
        "80",
        "PASS",
        "CSQ=T|missense_variant|MODERATE|TULP1|ENSG00000112041|ENST00000229771|ENST00000229771.11:c.1486G>A|ENSP00000229771.6:p.Val496Met|NM_003322.6|YES|0.0001|0.0002|",
      ].join("\t"),
    ].join("\n");
    expect(parseVcf(vcf, "GRCh38")[0]).toMatchObject({
      gene: "TULP1",
      transcript: "NM_003322.6",
      hgvsC: "c.1486G>A",
      hgvsP: "p.Val496Met",
    });
  });

  it("uses the gene MANE RefSeq when the chosen transcript has no NM_", () => {
    const vcf = [
      "##fileformat=VCFv4.2",
      VEP_HEADER,
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
      [
        "1",
        "100",
        ".",
        "G",
        "A",
        "80",
        "PASS",
        "CSQ=A|missense_variant|MODERATE|PSEN2|ENSG00000143801|ENST00000676945|ENST00000676945.1:c.1358G>A|p.Arg453His||YES|0.001|0.001|",
      ].join("\t"),
    ].join("\n");
    expect(parseVcf(vcf, "GRCh38")[0]).toMatchObject({
      gene: "PSEN2",
      transcript: "NM_000447.3",
      hgvsC: "c.1358G>A",
    });
  });

  it("keeps an Ensembl transcript when the record has no MANE RefSeq", () => {
    const vcf = [
      "##fileformat=VCFv4.2",
      VEP_HEADER,
      "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
      [
        "1",
        "100",
        ".",
        "A",
        "G",
        "80",
        "PASS",
        "CSQ=G|missense_variant|MODERATE|GENE1|ENSG1|ENST000001|ENST000001.1:c.2A>G|p.Met1Val||YES|0.01|0.01|",
      ].join("\t"),
    ].join("\n");
    expect(parseVcf(vcf, "GRCh38")[0]).toMatchObject({
      transcript: "ENST000001",
      hgvsC: "c.2A>G",
    });
  });
});

describe("VEP annotation command", () => {
  const paths = {
    assembly: "GRCh38" as const,
    inputPath: "/tmp/gvi-vep/input.vcf",
    outputPath: "/tmp/gvi-vep/annotated.vcf.gz",
  };

  it("calls annotate_vcf.sh with the vcf, assembly, output, and data dir", () => {
    expect(
      buildAnnotationCommand(
        {
          scriptPath: "/home/ken/gx-exome/src/annotate_vcf.sh",
          dataDir: "/home/ken/gx-exome",
        },
        paths
      )
    ).toEqual({
      command: "/home/ken/gx-exome/src/annotate_vcf.sh",
      args: [
        "--vcf",
        paths.inputPath,
        "--assembly",
        "GRCh38",
        "--out",
        paths.outputPath,
        "--data-dir",
        "/home/ken/gx-exome",
      ],
    });
  });

  it("names the saved file from the source VCF", () => {
    expect(annotatedVcfFileName("Eugenia_Molina_Alfaro_10263548.vcf")).toBe(
      "Eugenia_Molina_Alfaro_10263548.annotated.vcf.gz"
    );
    expect(annotatedVcfFileName("sample.vcf.gz")).toBe("sample.annotated.vcf.gz");
  });

  it("refuses a raw VCF when the gx-exome script or data dir is missing", () => {
    expect(() =>
      buildAnnotationCommand({ scriptPath: "", dataDir: "/home/ken/gx-exome" }, paths)
    ).toThrow(VcfAnnotationFailure);
  });
});

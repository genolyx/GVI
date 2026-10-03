import { gzipSync } from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  benignScvsFromSubmissionLines,
  clinvarSitesForBenignSubmissions,
  isBenignOrLikelyBenignSubmission,
  isMajorClinicalLab,
  loadMajorLabBenignSitesFrom,
  scvAccession,
} from "./clinvarLabs";

const header = [
  "#VariationID",
  "ClinicalSignificance",
  "DateLastEvaluated",
  "Description",
  "SubmittedPhenotypeInfo",
  "ReportedPhenotypeInfo",
  "ReviewStatus",
  "CollectionMethod",
  "OriginCounts",
  "Submitter",
  "SCV",
].join("\t");

function submission(submitter: string, significance: string, scv: string) {
  return ["1", significance, "-", "-", "-", "-", "-", "-", "-", submitter, scv].join("\t");
}

describe("major laboratory ClinVar submissions", () => {
  it("recognizes the clinical laboratories and not a research or registry submitter", () => {
    expect(isMajorClinicalLab("GeneDx")).toBe(true);
    expect(isMajorClinicalLab("Labcorp Genetics (formerly Invitae), Labcorp")).toBe(true);
    expect(isMajorClinicalLab("Women's Health and Genetics/Laboratory Corporation of America, LabCorp")).toBe(true);
    expect(isMajorClinicalLab("Natera, Inc.")).toBe(true);
    expect(isMajorClinicalLab("Baylor Genetics")).toBe(true);
    expect(isMajorClinicalLab("Ambry Genetics")).toBe(true);
    expect(isMajorClinicalLab("Blueprint Genetics")).toBe(true);
    expect(isMajorClinicalLab("PreventionGenetics, part of Exact Sciences")).toBe(true);
    expect(isMajorClinicalLab("Fulgent Genetics, Fulgent Genetics")).toBe(true);
    expect(
      isMajorClinicalLab(
        "The Central Laboratory of Birth Defects Prevention and Control, The Affiliated Women and Children's Hospital of Ningbo University"
      )
    ).toBe(false);
    expect(isMajorClinicalLab("GenomeConnect - Invitae Patient Insights Network")).toBe(false);
    expect(isMajorClinicalLab("Lupski Lab, Baylor-Hopkins CMG, Baylor College of Medicine")).toBe(false);
    expect(isBenignOrLikelyBenignSubmission("Likely benign")).toBe(true);
    expect(isBenignOrLikelyBenignSubmission("Benign/Likely benign")).toBe(true);
    expect(isBenignOrLikelyBenignSubmission("Likely pathogenic")).toBe(false);
    expect(scvAccession("SCV003526545.1")).toBe("SCV003526545");
  });

  it("keeps a site when one of those laboratories submitted Benign or Likely benign", () => {
    const scvs = benignScvsFromSubmissionLines([
      header,
      submission("Ambry Genetics", "Likely benign", "SCV000000001.2"),
      submission("GeneDx", "Likely pathogenic", "SCV000000002.1"),
      submission("Lupski Lab, Baylor-Hopkins CMG, Baylor College of Medicine", "Benign", "SCV000000003.1"),
    ]);
    expect([...scvs]).toEqual(["SCV000000001"]);
    const sites = clinvarSitesForBenignSubmissions(
      [
        "##fileformat=VCFv4.2",
        "1\t100\t.\tA\tG\t.\t.\tCLNSIG=Likely_benign;CLNSIGSCV=SCV000000001",
        "1\t200\t.\tA\tT\t.\t.\tCLNSIG=Likely_pathogenic;CLNSIGSCV=SCV000000002",
      ],
      scvs
    );
    expect([...sites]).toEqual(["1:100:A:G"]);
  });

  it("reads the gzipped submission summary and ClinVar VCF", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gvi-clinvar-labs-"));
    const summary = path.join(directory, "submission_summary.txt.gz");
    const vcf = path.join(directory, "clinvar.vcf.gz");
    await writeFile(
      summary,
      gzipSync(`${header}\n${submission("Natera, Inc.", "Benign", "SCV000000009.1")}\n`)
    );
    await writeFile(
      vcf,
      gzipSync("##fileformat=VCFv4.2\n1\t300\t.\tC\tT\t.\t.\tCLNSIGSCV=SCV000000009\n")
    );
    const sites = await loadMajorLabBenignSitesFrom(summary, vcf);
    expect([...sites]).toEqual(["1:300:C:T"]);
  });
});

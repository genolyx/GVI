import { describe, expect, it } from "vitest";
import { somaticExpertGoldSchema } from "./expertGold";

function validPack() {
  return {
    schemaVersion: 1,
    packVersion: "institution-gold-v1",
    status: "final",
    createdAt: "2026-09-27T00:00:00.000Z",
    deidentified: true,
    baseline: "AMP_ASCO_CAP_2017",
    institutionPolicyVersion: "SOP-SOMATIC-3.1.2",
    panelVersions: [
      {
        key: "panel-v4",
        manufacturer: "Example",
        name: "Example Cancer Panel",
        version: "4",
        genomeBuild: "GRCh38",
        reportableRegionsArtifactHash: "a".repeat(64),
        coverageValidationArtifactHash: "b".repeat(64),
      },
    ],
    cases: [
      {
        id: "GOLD-001",
        vcf: "vcf/GOLD-001.vcf.gz",
        tumor: {
          ontologySystem: "OncoTree",
          ontologyVersion: "2026-09",
          code: "LUAD",
          label: "Lung adenocarcinoma",
        },
        panelVersionKey: "panel-v4",
        variants: [
          {
            variantId: "GRCh38:7:55259515:T:G",
            gene: "EGFR",
            transcript: "NM_005228.5",
            hgvsC: "c.2573T>G",
            hgvsP: "p.Leu858Arg",
            normalizationStatus: "accepted",
            qcStatus: "pass",
            candidate: true,
            oncogenicity: "Oncogenic",
            clinicalDomain: "therapeutic",
            clinicalEffect: "sensitivity",
            finalAmpTier: "Tier I",
            finalAmpLevel: "A",
            reportable: true,
            rationale:
              "Adjudicated synthetic test rationale representing an expert-reviewed gold assertion.",
            evidenceRecordIds: ["CIVIC-EXAMPLE-1"],
            reviewStatus: "adjudicated",
            reviewerIds: ["reviewer-01", "reviewer-02"],
            reviewedAt: "2026-09-27T01:00:00.000Z",
          },
        ],
      },
    ],
  };
}

describe("somatic expert gold manifest", () => {
  it("accepts a de-identified adjudicated pack", () => {
    expect(somaticExpertGoldSchema.parse(validPack()).cases).toHaveLength(1);
  });

  it("rejects Tier I/II without an AMP level", () => {
    const pack = validPack();
    pack.cases[0].variants[0].finalAmpLevel = null as unknown as "A";
    const result = somaticExpertGoldSchema.safeParse(pack);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(issue =>
        issue.message.includes("requires a final AMP level")
      )
    ).toBe(true);
  });

  it("rejects identifying fields and unsafe VCF paths", () => {
    const pack = validPack() as ReturnType<typeof validPack> & {
      patientName?: string;
    };
    pack.patientName = "Must not be accepted";
    pack.cases[0].vcf = "../patient.vcf";
    const result = somaticExpertGoldSchema.safeParse(pack);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(
        issue =>
          issue.path.join(".") === "" &&
          issue.message.includes("patientName")
      )
    ).toBe(true);
    expect(
      result.error?.issues.some(
        issue => issue.path.join(".") === "cases.0.vcf"
      )
    ).toBe(true);
  });

  it("rejects draft reviews in a final pack", () => {
    const pack = validPack();
    pack.cases[0].variants[0].reviewStatus = "draft" as "adjudicated";
    const result = somaticExpertGoldSchema.safeParse(pack);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(issue =>
        issue.message.includes("cannot contain draft")
      )
    ).toBe(true);
  });
});


import { describe, expect, it } from "vitest";
import { createReportDigest } from "./reportSnapshot";

const goldenSnapshot = {
  schemaVersion: "somatic-report-snapshot-2",
  report: {
    id: 501,
    version: 2,
    title: "SOM-2026-0042 Somatic Cancer Biomarker Report",
    content: {
      schemaVersion: "somatic-report-1",
      editable: {
        summary: "One expert-approved somatic assertion is included.",
        interpretation:
          "EGFR p.Leu858Arg supports sensitivity in this disease context.",
        methodology: "Target-panel VCF; Acme Oncology 500 v3; GRCh38.",
        limitations: "Coverage and assay limitations apply.",
        recommendations:
          "Correlate with pathology, clinical history, and prior therapy.",
      },
    },
  },
  template: {
    id: 12,
    versionId: 18,
    version: 3,
    schema: {
      schemaVersion: "1",
      name: "Somatic Cancer Biomarker Report",
      locale: "en",
      sections: [
        {
          id: "significant_findings",
          visible: true,
          title: "Clinically Significant Alterations",
        },
        {
          id: "limitations",
          visible: true,
          title: "Methodology and Limitations",
        },
      ],
      includeTierIV: false,
      disclaimer: "Clinical decision support; expert review required.",
    },
  },
  case: {
    id: 42,
    organizationId: 7,
    caseNumber: "SOM-2026-0042",
    purpose: "somatic",
    referenceBuild: "GRCh38",
  },
  tumorContext: {
    specimenType: "FFPE",
    tumorContentPercent: "45.00",
    primaryTumorTypeId: 9,
    panelVersionId: 22,
  },
  tumor: {
    id: 9,
    code: "NSCLC",
    label: "Non-small cell lung cancer",
  },
  panel: {
    id: 4,
    manufacturer: "Acme",
    name: "Oncology 500",
  },
  panelVersion: {
    id: 22,
    version: "3",
    genomeBuild: "GRCh38",
  },
  interpretationRun: {
    id: 81,
    status: "ready_for_review",
    pipelineVersion: "somatic-cds-1",
    rulesetVersion: "amp-2017-review-required-2",
    knowledgeVersions: {
      CIViC: "2026-01-15",
      OncoKB: "disabled_pending_clinical_license",
    },
    completedAt: "2026-09-27T07:55:00.000Z",
  },
  provenance: {
    assembly: "GRCh38",
    transcriptPolicy: ["submitted_transcript"],
    pipelineVersion: "somatic-cds-1",
    rulesetVersion: "amp-2017-review-required-2",
    knowledgeVersions: {
      CIViC: "2026-01-15",
      OncoKB: "disabled_pending_clinical_license",
    },
    templateVersionId: 18,
  },
  variantAnalyses: [
    {
      analysis: {
        variantId: 301,
        normalizationStatus: "normalized",
        normalizedRepresentation: {
          normalizedId: "GRCh38:7:55259515:T:G",
          transcript: "NM_005228.5",
        },
        transcriptPolicy: "submitted_transcript",
        qcStatus: "pass",
        qcReasons: [],
      },
      variant: {
        id: 301,
        normalizedId: "GRCh38:7:55259515:T:G",
        gene: "EGFR",
        hgvsC: "c.2573T>G",
        hgvsP: "p.Leu858Arg",
        vaf: "0.3100",
        readDepth: 420,
      },
    },
  ],
  assertions: [
    {
      assertionId: 901,
      variantId: 301,
      gene: "EGFR",
      hgvsC: "c.2573T>G",
      hgvsP: "p.Leu858Arg",
      transcript: "NM_005228.5",
      vaf: "0.3100",
      depth: 420,
      tier: "Tier I",
      level: "A",
      oncogenicity: "Oncogenic",
      clinicalDomain: "therapeutic",
      clinicalEffect: "sensitivity",
      rationale: "Reviewed disease-matched therapeutic evidence.",
      evidenceIds: [701],
    },
  ],
  evidence: [
    {
      id: 701,
      sourceName: "CIViC",
      sourceVersion: "2026-01-15",
      sourceRecordId: "CIVIC-12345",
      sourceNativeLevel: "A",
      rawResponseHash:
        "09b5a9e17b83441fc75327b3f7cfdb28bdfd1a0b9f460b25ca17d97b68f7a201",
      retrievedAt: "2026-09-27T07:45:00.000Z",
    },
  ],
  signature: {
    userId: 14,
    name: "Alex Clinician",
    email: "alex@example.test",
    role: "clinician",
    signedAt: "2026-09-27T08:00:00.000Z",
    attestation:
      "I reviewed the somatic assertions, evidence, limitations, and current immutable report version.",
  },
};

describe("somatic-report-snapshot-2 golden contract", () => {
  it("produces the fixed golden digest", () => {
    expect(createReportDigest(goldenSnapshot).sha256).toBe(
      "1e7310309be01d9465cdca3d63d50ba620fc9022d197984b513cbd4f08595484"
    );
  });

  it("pins every report provenance version to the signed package", () => {
    expect(goldenSnapshot.provenance).toEqual({
      assembly: goldenSnapshot.case.referenceBuild,
      transcriptPolicy: ["submitted_transcript"],
      pipelineVersion: goldenSnapshot.interpretationRun.pipelineVersion,
      rulesetVersion: goldenSnapshot.interpretationRun.rulesetVersion,
      knowledgeVersions: goldenSnapshot.interpretationRun.knowledgeVersions,
      templateVersionId: goldenSnapshot.template.versionId,
    });
    expect(goldenSnapshot.evidence[0]).toMatchObject({
      sourceName: "CIViC",
      sourceVersion: "2026-01-15",
      sourceNativeLevel: "A",
      rawResponseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ["assembly", { assembly: "GRCh37" }],
    ["pipeline", { pipelineVersion: "somatic-cds-2" }],
    ["ruleset", { rulesetVersion: "amp-2017-review-required-3" }],
    ["knowledge", { knowledgeVersions: { CIViC: "2026-02-01" } }],
    ["template", { templateVersionId: 19 }],
  ])("binds the digest to %s provenance", (_label, provenanceChange) => {
    expect(
      createReportDigest({
        ...goldenSnapshot,
        provenance: {
          ...goldenSnapshot.provenance,
          ...provenanceChange,
        },
      }).sha256
    ).not.toBe(createReportDigest(goldenSnapshot).sha256);
  });
});

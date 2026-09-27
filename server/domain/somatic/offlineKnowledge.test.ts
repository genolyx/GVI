import { describe, expect, it } from "vitest";
import {
  diffKnowledgeReleaseRecords,
  offlineEvidenceInsertValues,
  offlineKnowledgeEvidenceSchema,
} from "./offlineKnowledge";

function record() {
  return {
    normalizedVariantId: "GRCh38:7:55259515:T:G",
    sourceRecordId: "CIVIC-1",
    sourceNativeLevel: "A",
    clinicalDomain: "therapeutic" as const,
    direction: "supporting" as const,
    diseaseOntology: {
      ontologySystem: "OncoTree",
      ontologyVersion: "2026-09",
      code: "LUAD",
    },
    summary: "Version-pinned offline evidence.",
    sourceUrl: "https://civicdb.org/evidence/1",
    rawResponseHash: "a".repeat(64),
    payload: {
      evidenceType: "PREDICTIVE",
      ampTier: "must-be-removed",
      finalLevel: "must-be-removed",
    },
  };
}

describe("offline somatic knowledge releases", () => {
  it("validates pinned disease metadata and strips derived AMP fields", () => {
    const parsed = offlineKnowledgeEvidenceSchema.parse(record());
    const values = offlineEvidenceInsertValues(4, 8, parsed);

    expect(values.payload).toMatchObject({
      evidenceType: "PREDICTIVE",
      diseaseOntology: { code: "LUAD" },
    });
    expect(values.payload).not.toHaveProperty("ampTier");
    expect(values.payload).not.toHaveProperty("finalLevel");
  });

  it("rejects records without version-pinned disease context", () => {
    const input = record() as ReturnType<typeof record> & {
      diseaseOntology?: ReturnType<typeof record>["diseaseOntology"];
    };
    delete input.diseaseOntology;
    expect(offlineKnowledgeEvidenceSchema.safeParse(input).success).toBe(false);
  });

  it("computes added, removed, and changed release impact", () => {
    const previous = [
      {
        normalizedVariantId: "GRCh38:1:1:A:T",
        sourceRecordId: "stable",
        rawResponseHash: "a".repeat(64),
      },
      {
        normalizedVariantId: "GRCh38:2:2:A:G",
        sourceRecordId: "changed",
        rawResponseHash: "b".repeat(64),
      },
      {
        normalizedVariantId: "GRCh38:3:3:C:T",
        sourceRecordId: "removed",
        rawResponseHash: "c".repeat(64),
      },
    ];
    const target = [
      previous[0],
      { ...previous[1], rawResponseHash: "d".repeat(64) },
      {
        normalizedVariantId: "GRCh38:4:4:G:A",
        sourceRecordId: "added",
        rawResponseHash: "e".repeat(64),
      },
    ];

    expect(diffKnowledgeReleaseRecords(previous, target)).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      impactedVariantIds: [
        "GRCh38:2:2:A:G",
        "GRCh38:3:3:C:T",
        "GRCh38:4:4:G:A",
      ],
    });
  });
});


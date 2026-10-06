import { describe, expect, it } from "vitest";
import { classifyNccn, parseNccnRevision, type NccnEvidenceRevision } from "./classify";

function revision(
  overrides: Partial<NccnEvidenceRevision> = {}
): NccnEvidenceRevision {
  return {
    evidenceId: "ev-1",
    assertionId: "as-1",
    status: "active",
    guidelineVersion: "1.2026",
    guidelineTitle: "NSCLC",
    section: "NSCL-1",
    domain: "therapeutic",
    effect: "sensitivity",
    nccnCategory: "1",
    preference: null,
    hasPanelDissent: false,
    panTumor: false,
    tumorCodes: ["NSCLC"],
    excludedTumorCodes: [],
    biomarkerType: "SNV_INDEL",
    gene: "EGFR",
    matchMode: "EXACT",
    exactVariants: ["p.L858R"],
    includedVariants: [],
    excludedVariants: [],
    functionalClass: null,
    conditions: [],
    therapyConditions: [],
    regimen: null,
    sourceDrugNames: [],
    approval: null,
    regionalAvailability: null,
    variantOriginRequired: "somatic",
    underlyingSourceKeys: ["src-1"],
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

const base = {
  knowledgeReleaseId: "release-1",
  analysisAsOf: "2026-10-06",
  gene: "EGFR",
  variantType: "SNV_INDEL" as const,
  normalizedVariant: "p.L858R",
  copyChange: null,
  functionalClass: null,
  variantOrigin: "somatic" as const,
  tumorCode: "NSCLC",
  patient: {},
};

describe("NCCN classification order", () => {
  it("accepts a revision that has no drug fields yet", () => {
    const parsed = parseNccnRevision({
      kind: "nccn_evidence_revision",
      evidenceId: "ev-1",
      assertionId: "as-1",
      status: "active",
      guidelineVersion: "1.2026",
      guidelineTitle: "NSCLC",
      domain: "therapeutic",
      effect: "sensitivity",
      nccnCategory: "1",
      biomarkerType: "SNV_INDEL",
      gene: "EGFR",
      matchMode: "EXACT",
    });
    expect(parsed?.regimen).toBeNull();
    expect(parsed?.therapyConditions).toEqual([]);
  });

  it("records the classification steps in order and leaves the tier unfinalized", () => {
    const result = classifyNccn({ ...base, revisions: [revision()] });
    expect(result.steps.map(step => step.id)).toEqual([
      "validate_input",
      "fix_release",
      "search_assertions",
      "biomarker_match",
      "tumor_match",
      "exclusions",
      "regimen_identity",
      "clinical_conditions",
      "evidence_validity",
      "amp_candidate",
      "collapse_duplicates",
      "domain_results",
      "conflict_check",
      "provisional_tier",
    ]);
    expect(result.overallTier).toBeNull();
    expect(result.classificationStatus).toBe("review_required");
    expect(result.provisionalTier).toBe("I");
    expect(result.assertionResults[0]?.candidateLevel).toBe("A");
    expect(result.assertionResults[0]?.nccnCategory).toBe("1");
    expect(result.assertionResults[0]?.ruleIds).toContain("NCCN-R1");
  });

  it("does not turn category 2A into AMP level B", () => {
    const result = classifyNccn({
      ...base,
      revisions: [revision({ nccnCategory: "2A" })],
    });
    expect(result.assertionResults[0]?.candidateLevel).toBe("A");
    expect(result.assertionResults[0]?.candidateLevel).not.toBe("B");
  });

  it("sends category 2B and panel dissent to review without a level", () => {
    const category = classifyNccn({
      ...base,
      revisions: [revision({ nccnCategory: "2B" })],
    });
    const dissent = classifyNccn({
      ...base,
      revisions: [revision({ hasPanelDissent: true })],
    });
    expect(category.assertionResults[0]?.candidateLevel).toBeNull();
    expect(category.assertionResults[0]?.reasonCodes).toContain("CATEGORY_2B_REVIEW");
    expect(dissent.assertionResults[0]?.candidateLevel).toBeNull();
    expect(dissent.classificationStatus).toBe("review_required");
  });

  it("keeps a different tumor at a level C candidate", () => {
    const result = classifyNccn({
      ...base,
      tumorCode: "CRC",
      revisions: [revision()],
    });
    expect(result.assertionResults[0]?.candidateLevel).toBe("C");
    expect(result.provisionalTier).toBe("II");
    expect(result.assertionResults[0]?.ruleIds).toContain("NCCN-R4");
  });

  it("does not assign tier III or IV when no NCCN revision matches", () => {
    const result = classifyNccn({ ...base, revisions: [] });
    expect(result.nccnMatchStatus).toBe("no_matching_nccn_evidence");
    expect(result.overallTier).toBeNull();
    expect(result.provisionalTier).toBeNull();
    expect(result.steps.at(-1)?.reasonCodes).toContain("NO_MATCHING_NCCN_EVIDENCE");
  });

  it("keeps clinical significance when the treatment line is missing", () => {
    const result = classifyNccn({
      ...base,
      patient: {},
      revisions: [revision({ conditions: [{ field: "treatmentLine", value: "2L+" }] })],
    });
    expect(result.nccnMatchStatus).toBe("insufficient_information");
    expect(result.assertionResults[0]?.clinicalSignificance).toBe("T");
    expect(result.assertionResults[0]?.patientApplicability).toBe("U");
    expect(result.assertionResults[0]?.candidateLevel).toBe("A");
  });

  it("keeps an unknown functional class unknown", () => {
    const result = classifyNccn({
      ...base,
      functionalClass: null,
      revisions: [
        revision({
          matchMode: "FUNCTIONAL_CLASS",
          functionalClass: "activating",
          exactVariants: [],
        }),
      ],
    });
    expect(result.assertionResults[0]?.biomarkerMatch).toBe("U");
    expect(result.nccnMatchStatus).toBe("insufficient_information");
    expect(result.provisionalTier).toBeNull();
  });

  it("does not use a gene-only match for a curated group", () => {
    const result = classifyNccn({
      ...base,
      normalizedVariant: "p.G719A",
      revisions: [
        revision({
          matchMode: "CURATED_GROUP",
          exactVariants: [],
          includedVariants: ["p.L858R"],
        }),
      ],
    });
    expect(result.nccnMatchStatus).toBe("no_matching_nccn_evidence");
  });

  it("does not treat gain as amplification", () => {
    const result = classifyNccn({
      ...base,
      variantType: "COPY_NUMBER",
      copyChange: "gain",
      revisions: [
        revision({
          biomarkerType: "COPY_NUMBER",
          exactVariants: ["amplification"],
        }),
      ],
    });
    expect(result.assertionResults[0]?.biomarkerMatch).toBe("F");
  });

  it("ignores draft evidence and collapses duplicate sources", () => {
    const result = classifyNccn({
      ...base,
      revisions: [
        revision({ status: "draft", evidenceId: "draft" }),
        revision({ evidenceId: "a", assertionId: "a" }),
        revision({ evidenceId: "b", assertionId: "b", underlyingSourceKeys: ["src-1"] }),
      ],
    });
    expect(result.assertionResults.map(item => item.evidenceId)).toEqual(["a", "b"]);
    expect(result.assertionResults[1]?.reasonCodes).toContain("DUPLICATE_SOURCE_COLLAPSED");
    expect(result.provisionalTier).toBe("I");
  });

  it("leaves the overall tier empty when sensitivity and resistance conflict", () => {
    const result = classifyNccn({
      ...base,
      revisions: [
        revision({ evidenceId: "s", assertionId: "s", underlyingSourceKeys: ["s"] }),
        revision({
          evidenceId: "r",
          assertionId: "r",
          effect: "resistance",
          underlyingSourceKeys: ["r"],
        }),
      ],
    });
    expect(result.conflicts).toEqual([
      "therapeutic|unspecified:sensitivity_resistance",
    ]);
    expect(result.overallTier).toBeNull();
    expect(result.classificationStatus).toBe("review_required");
  });

  it("does not let testing-only evidence become level A", () => {
    const result = classifyNccn({
      ...base,
      revisions: [revision({ domain: "testing_only", effect: "testing" })],
    });
    expect(result.assertionResults[0]?.candidateLevel).toBeNull();
    expect(result.assertionResults[0]?.reasonCodes).toContain("TESTING_ONLY");
    expect(result.provisionalTier).toBeNull();
  });

  it("does not treat sensitivity and resistance for different regimens as a conflict", () => {
    const result = classifyNccn({
      ...base,
      revisions: [
        revision({
          evidenceId: "s",
          assertionId: "s",
          underlyingSourceKeys: ["s"],
          regimen: {
            id: "osimertinib",
            drugIds: ["drug-osi"],
            combinationType: "monotherapy",
            orderMatters: false,
          },
        }),
        revision({
          evidenceId: "r",
          assertionId: "r",
          effect: "resistance",
          underlyingSourceKeys: ["r"],
          regimen: {
            id: "erlotinib",
            drugIds: ["drug-erl"],
            combinationType: "monotherapy",
            orderMatters: false,
          },
        }),
      ],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.steps.find(step => step.id === "conflict_check")?.reasonCodes).toContain(
      "NCCN-R12"
    );
    expect(result.provisionalTier).toBe("I");
  });

  it("keeps a combination as one regimen and does not level an unmapped OncoKB name", () => {
    const combination = classifyNccn({
      ...base,
      revisions: [
        revision({
          regimen: {
            id: "combo-1",
            drugIds: ["drug-a", "drug-b"],
            combinationType: "combination",
            orderMatters: false,
          },
        }),
      ],
    });
    expect(combination.assertionResults).toHaveLength(1);
    expect(combination.assertionResults[0]?.reasonCodes).toContain("COMBINATION_NOT_SPLIT");
    expect(combination.assertionResults[0]?.candidateLevel).toBe("A");

    const unmapped = classifyNccn({
      ...base,
      catalog: { version: "test", drugs: [], classes: [], regimens: [] },
      revisions: [
        revision({
          regimen: {
            id: "osi",
            drugIds: ["drug-osi"],
            combinationType: "monotherapy",
            orderMatters: false,
          },
          sourceDrugNames: [{ source: "oncokb", name: "Osimertinib" }],
        }),
      ],
    });
    expect(unmapped.assertionResults[0]?.candidateLevel).toBeNull();
    expect(unmapped.assertionResults[0]?.reasonCodes).toContain("DRUG_UNMAPPED");
    expect(unmapped.provisionalTier).toBeNull();
  });

  it("matches prior therapy by class id and keeps the level when the history is missing", () => {
    const catalog = {
      version: "test",
      drugs: [],
      classes: [{ id: "class-egfr-tki", memberDrugIds: ["drug-osi", "drug-erl"] }],
      regimens: [],
    };
    const matched = classifyNccn({
      ...base,
      catalog,
      priorTherapyKnown: true,
      priorTherapyDrugIds: ["drug-osi"],
      revisions: [
        revision({
          therapyConditions: [
            { targetType: "class", targetId: "class-egfr-tki", expected: "present" },
          ],
        }),
      ],
    });
    expect(matched.assertionResults[0]?.patientApplicability).toBe("T");
    expect(matched.assertionResults[0]?.candidateLevel).toBe("A");

    const otherDrug = classifyNccn({
      ...base,
      catalog,
      priorTherapyKnown: true,
      priorTherapyDrugIds: ["drug-osi"],
      revisions: [
        revision({
          therapyConditions: [
            { targetType: "drug", targetId: "drug-erl", expected: "present" },
          ],
        }),
      ],
    });
    expect(otherDrug.assertionResults[0]?.patientApplicability).toBe("F");
    expect(otherDrug.assertionResults[0]?.candidateLevel).toBeNull();

    const missing = classifyNccn({
      ...base,
      catalog,
      priorTherapyKnown: false,
      revisions: [
        revision({
          therapyConditions: [
            { targetType: "class", targetId: "class-egfr-tki", expected: "present" },
          ],
        }),
      ],
    });
    expect(missing.nccnMatchStatus).toBe("insufficient_information");
    expect(missing.assertionResults[0]?.candidateLevel).toBe("A");
  });

  it("records FDA and MFDS approval without changing the candidate level", () => {
    const result = classifyNccn({
      ...base,
      revisions: [
        revision({
          approval: { fda: "unknown", mfds: "not_approved", offLabel: true },
          regionalAvailability: {
            region: "KR",
            approvalStatus: "not_approved",
            reimbursementStatus: "unknown",
          },
        }),
      ],
    });
    expect(result.assertionResults[0]?.candidateLevel).toBe("A");
    expect(result.assertionResults[0]?.fdaApproval).toBe("unknown");
    expect(result.assertionResults[0]?.mfdsApproval).toBe("not_approved");
    expect(result.assertionResults[0]?.reasonCodes).toContain(
      "APPROVAL_DOES_NOT_CHANGE_LEVEL"
    );
    expect(result.assertionResults[0]?.ruleIds).toContain("NCCN-R10");
  });
});

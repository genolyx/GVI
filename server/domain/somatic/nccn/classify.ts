import {
  NCCN_POLICY,
  NCCN_RULE_VERSION,
  type NccnAssertionResult,
  type NccnEvaluation,
  type NccnStep,
  type Tri,
} from "@shared/nccn";
import { z } from "zod";
import {
  regimenIdentity,
  resolveDrugId,
  type DrugCatalog,
  type DrugSource,
  type RegimenDefinition,
} from "./drugs";

export type NccnEvidenceRevision = {
  evidenceId: string;
  assertionId: string;
  status: "draft" | "reviewed" | "active" | "superseded" | "withdrawn" | "rejected";
  guidelineVersion: string;
  guidelineTitle: string;
  section: string | null;
  domain: "therapeutic" | "diagnostic" | "prognostic" | "testing_only";
  effect:
    | "sensitivity"
    | "resistance"
    | "diagnostic"
    | "prognostic"
    | "testing"
    | "contraindicated";
  nccnCategory: "1" | "2A" | "2B" | "3";
  preference: string | null;
  hasPanelDissent: boolean;
  panTumor: boolean;
  tumorCodes: string[];
  excludedTumorCodes: string[];
  biomarkerType: "SNV_INDEL" | "FUSION" | "COPY_NUMBER" | "OTHER";
  gene: string;
  matchMode: "EXACT" | "CURATED_GROUP" | "FUNCTIONAL_CLASS";
  exactVariants: string[];
  includedVariants: string[];
  excludedVariants: string[];
  functionalClass: string | null;
  conditions: Array<{ field: string; value: string }>;
  therapyConditions: Array<{
    targetType: "drug" | "class";
    targetId: string;
    expected: "present" | "absent";
  }>;
  regimen: RegimenDefinition | null;
  sourceDrugNames: Array<{ source: DrugSource; name: string }>;
  approval: {
    fda: "approved" | "not_approved" | "unknown";
    mfds: "approved" | "not_approved" | "unknown";
    offLabel: boolean;
  } | null;
  regionalAvailability: {
    region: "KR";
    approvalStatus: "approved" | "not_approved" | "unknown";
    reimbursementStatus: "reimbursed" | "not_reimbursed" | "unknown";
  } | null;
  variantOriginRequired: "somatic" | "germline" | "either" | "unspecified";
  underlyingSourceKeys: string[];
  validFrom: string | null;
  validTo: string | null;
};

export type NccnClassifyInput = {
  knowledgeReleaseId: string | null;
  analysisAsOf: string;
  gene: string | null;
  variantType: "SNV_INDEL" | "FUSION" | "COPY_NUMBER" | "OTHER";
  normalizedVariant: string | null;
  copyChange: "amplification" | "deletion" | "gain" | null;
  functionalClass: string | null;
  variantOrigin: "somatic" | "germline" | "unknown";
  tumorCode: string | null;
  patient: Record<string, string | undefined>;
  priorTherapyDrugIds?: string[];
  priorTherapyKnown?: boolean;
  catalog?: DrugCatalog;
  revisions: NccnEvidenceRevision[];
};

const revisionSchema = z
  .object({
    kind: z.literal("nccn_evidence_revision"),
    evidenceId: z.string().min(1),
    assertionId: z.string().min(1),
    status: z.enum(["draft", "reviewed", "active", "superseded", "withdrawn", "rejected"]),
    guidelineVersion: z.string().min(1),
    guidelineTitle: z.string().min(1),
    section: z.string().nullable().default(null),
    domain: z.enum(["therapeutic", "diagnostic", "prognostic", "testing_only"]),
    effect: z.enum(["sensitivity", "resistance", "diagnostic", "prognostic", "testing", "contraindicated"]),
    nccnCategory: z.enum(["1", "2A", "2B", "3"]),
    preference: z.string().nullable().default(null),
    hasPanelDissent: z.boolean().default(false),
    panTumor: z.boolean().default(false),
    tumorCodes: z.array(z.string()).default([]),
    excludedTumorCodes: z.array(z.string()).default([]),
    biomarkerType: z.enum(["SNV_INDEL", "FUSION", "COPY_NUMBER", "OTHER"]),
    gene: z.string().min(1),
    matchMode: z.enum(["EXACT", "CURATED_GROUP", "FUNCTIONAL_CLASS"]),
    exactVariants: z.array(z.string()).default([]),
    includedVariants: z.array(z.string()).default([]),
    excludedVariants: z.array(z.string()).default([]),
    functionalClass: z.string().nullable().default(null),
    conditions: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
    therapyConditions: z
      .array(
        z.object({
          targetType: z.enum(["drug", "class"]),
          targetId: z.string().min(1),
          expected: z.enum(["present", "absent"]),
        })
      )
      .default([]),
    regimen: z
      .object({
        id: z.string().min(1),
        drugIds: z.array(z.string().min(1)).min(1),
        combinationType: z.enum(["monotherapy", "combination", "sequential"]),
        orderMatters: z.boolean().default(false),
      })
      .nullable()
      .default(null),
    sourceDrugNames: z
      .array(
        z.object({
          source: z.enum(["oncokb", "civic", "nccn", "rxnorm", "ncit"]),
          name: z.string().min(1),
        })
      )
      .default([]),
    approval: z
      .object({
        fda: z.enum(["approved", "not_approved", "unknown"]),
        mfds: z.enum(["approved", "not_approved", "unknown"]),
        offLabel: z.boolean(),
      })
      .nullable()
      .default(null),
    regionalAvailability: z
      .object({
        region: z.literal("KR"),
        approvalStatus: z.enum(["approved", "not_approved", "unknown"]),
        reimbursementStatus: z.enum(["reimbursed", "not_reimbursed", "unknown"]),
      })
      .nullable()
      .default(null),
    variantOriginRequired: z.enum(["somatic", "germline", "either", "unspecified"]).default("unspecified"),
    underlyingSourceKeys: z.array(z.string()).default([]),
    validFrom: z.string().nullable().default(null),
    validTo: z.string().nullable().default(null),
  })
  .strict();

/** Accept only structured revisions. Free-text guideline bodies are rejected. */
export function parseNccnRevision(value: unknown): NccnEvidenceRevision | null {
  const parsed = revisionSchema.safeParse(value);
  if (!parsed.success) return null;
  const { kind: _kind, ...revision } = parsed.data;
  return revision;
}

function andTri(values: Tri[]): Tri {
  if (values.includes("F")) return "F";
  if (values.includes("U")) return "U";
  return "T";
}

function same(left: string, right: string) {
  return left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

function inDate(revision: NccnEvidenceRevision, asOf: string) {
  if (revision.validFrom && revision.validFrom > asOf) return false;
  if (revision.validTo && revision.validTo < asOf) return false;
  return true;
}

function biomarkerMatch(
  input: NccnClassifyInput,
  revision: NccnEvidenceRevision
): { value: Tri; reasons: string[] } {
  if (input.variantType !== revision.biomarkerType) {
    return { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
  }
  if (!input.gene || !same(input.gene, revision.gene)) {
    return { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
  }
  const identity = input.normalizedVariant?.toLocaleUpperCase() ?? "";
  if (
    revision.excludedVariants.some(item => same(item, identity)) ||
    (input.copyChange &&
      revision.excludedVariants.some(item => same(item, input.copyChange!)))
  ) {
    return { value: "F", reasons: ["VARIANT_EXCLUDED"] };
  }
  if (revision.biomarkerType === "COPY_NUMBER") {
    if (!input.copyChange) return { value: "U", reasons: ["COPY_CHANGE_UNKNOWN"] };
    const allowed = [...revision.exactVariants, ...revision.includedVariants];
    return allowed.some(item => same(item, input.copyChange!))
      ? { value: "T", reasons: ["EXACT_VARIANT_MATCH"] }
      : { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
  }
  if (revision.matchMode === "EXACT") {
    const allowed = [...revision.exactVariants, ...revision.includedVariants];
    return allowed.some(item => same(item, identity))
      ? { value: "T", reasons: ["EXACT_VARIANT_MATCH"] }
      : { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
  }
  if (revision.matchMode === "CURATED_GROUP") {
    return revision.includedVariants.some(item => same(item, identity))
      ? { value: "T", reasons: ["CURATED_GROUP_MATCH"] }
      : { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
  }
  if (!input.functionalClass || input.functionalClass === "Not Evaluated") {
    return { value: "U", reasons: ["FUNCTIONAL_CLASS_UNKNOWN"] };
  }
  return revision.functionalClass &&
    same(revision.functionalClass, input.functionalClass)
    ? { value: "T", reasons: ["FUNCTIONAL_CLASS_MATCH"] }
    : { value: "F", reasons: ["BIOMARKER_MISMATCH"] };
}

function tumorMatch(
  input: NccnClassifyInput,
  revision: NccnEvidenceRevision
): { value: Tri; reasons: string[]; otherTumor: boolean } {
  if (!input.tumorCode) return { value: "U", reasons: [], otherTumor: false };
  if (revision.excludedTumorCodes.some(code => same(code, input.tumorCode!))) {
    return { value: "F", reasons: ["TUMOR_EXCLUDED"], otherTumor: false };
  }
  if (
    revision.panTumor ||
    revision.tumorCodes.some(code => same(code, input.tumorCode!))
  ) {
    return {
      value: "T",
      reasons: [revision.panTumor ? "PAN_TUMOR_MATCH" : "EXACT_TUMOR_MATCH"],
      otherTumor: false,
    };
  }
  return { value: "F", reasons: ["OTHER_TUMOR"], otherTumor: true };
}

function applicability(input: NccnClassifyInput, revision: NccnEvidenceRevision) {
  const reasons: string[] = [];
  if (
    revision.variantOriginRequired !== "either" &&
    revision.variantOriginRequired !== "unspecified"
  ) {
    if (input.variantOrigin === "unknown") {
      reasons.push("ORIGIN_UNKNOWN");
      return { value: "U" as Tri, reasons };
    }
    if (input.variantOrigin !== revision.variantOriginRequired) {
      reasons.push("ORIGIN_MISMATCH");
      return { value: "F" as Tri, reasons };
    }
  }
  const values = revision.conditions.map(condition => {
    const raw = input.patient[condition.field];
    if (!raw || raw === "unknown" || raw === "not_tested") return "U" as Tri;
    return raw === condition.value ? ("T" as Tri) : ("F" as Tri);
  });
  for (const condition of revision.therapyConditions ?? []) {
    reasons.push(NCCN_POLICY.priorTherapyByIdentity);
    if (!input.priorTherapyKnown) {
      values.push("U");
      continue;
    }
    const priors = input.priorTherapyDrugIds ?? [];
    if (condition.targetType === "drug") {
      const hit = priors.includes(condition.targetId);
      values.push(condition.expected === "present" ? (hit ? "T" : "F") : hit ? "F" : "T");
      continue;
    }
    const drugClass = input.catalog?.classes.find(
      item => item.id === condition.targetId
    );
    if (!drugClass) {
      values.push("U");
      reasons.push("DRUG_CLASS_UNKNOWN");
      continue;
    }
    const hit = drugClass.memberDrugIds.some(drugId => priors.includes(drugId));
    values.push(
      condition.expected === "present" ? (hit ? "T" : "F") : hit ? "F" : "T"
    );
  }
  if (!values.length) return { value: "T" as Tri, reasons };
  const value = andTri(values);
  if (value === "U") reasons.push("INSUFFICIENT_INFORMATION");
  if (value === "F") reasons.push("CONDITION_NOT_MET");
  return { value, reasons };
}

function regimenCheck(input: NccnClassifyInput, revision: NccnEvidenceRevision) {
  const reasons: string[] = [];
  const regimen = revision.regimen;
  if (!regimen) return { ok: true, reasons };
  const monotherapy = regimen.combinationType === "monotherapy";
  if (monotherapy ? regimen.drugIds.length !== 1 : regimen.drugIds.length < 2) {
    return { ok: false, reasons: ["REGIMEN_SHAPE_INVALID"] };
  }
  if (!monotherapy) {
    reasons.push("COMBINATION_NOT_SPLIT");
  }
  if (!(revision.sourceDrugNames ?? []).length) return { ok: true, reasons };
  const catalog = input.catalog ?? {
    version: "none",
    drugs: [],
    classes: [],
    regimens: [],
  };
  const resolved: string[] = [];
  for (const alias of revision.sourceDrugNames ?? []) {
    const id = resolveDrugId(catalog, alias.name, alias.source);
    if (!id) return { ok: false, reasons: [...reasons, "DRUG_UNMAPPED"] };
    resolved.push(id);
  }
  const expected = [...regimen.drugIds].sort().join("+");
  const got = Array.from(new Set(resolved)).sort().join("+");
  if (expected !== got) {
    return { ok: false, reasons: [...reasons, "DRUG_IDENTITY_MISMATCH"] };
  }
  return { ok: true, reasons };
}

function candidateFor(
  revision: NccnEvidenceRevision,
  otherTumor: boolean
): Pick<NccnAssertionResult, "candidateLevel" | "provisionalTier" | "ruleIds" | "reasonCodes"> {
  const ruleIds: string[] = [];
  const reasonCodes: string[] = [];
  if (revision.domain === "testing_only" || revision.effect === "testing") {
    ruleIds.push(NCCN_POLICY.testingOnlyCannotBeLevelA);
    reasonCodes.push("TESTING_ONLY");
    return { candidateLevel: null, provisionalTier: null, ruleIds, reasonCodes };
  }
  if (revision.nccnCategory === "2B") {
    ruleIds.push(NCCN_POLICY.category2BReview);
    reasonCodes.push("CATEGORY_2B_REVIEW");
    return { candidateLevel: null, provisionalTier: null, ruleIds, reasonCodes };
  }
  if (revision.nccnCategory === "3" || revision.hasPanelDissent) {
    ruleIds.push(NCCN_POLICY.category3OrDissentReview);
    reasonCodes.push("CATEGORY_3_OR_DISSENT_REVIEW");
    return { candidateLevel: null, provisionalTier: null, ruleIds, reasonCodes };
  }
  if (revision.preference) {
    ruleIds.push(NCCN_POLICY.preferenceDoesNotChangeLevel);
    reasonCodes.push("PREFERENCE_RECORDED");
  }
  if (revision.approval || revision.regionalAvailability) {
    ruleIds.push(NCCN_POLICY.approvalDoesNotChangeLevel);
    reasonCodes.push("APPROVAL_DOES_NOT_CHANGE_LEVEL");
  }
  if (otherTumor) {
    ruleIds.push(NCCN_POLICY.otherTumorLevelC);
    reasonCodes.push("OTHER_TUMOR_LEVEL_C_CANDIDATE");
    return { candidateLevel: "C", provisionalTier: "II", ruleIds, reasonCodes };
  }
  if (revision.nccnCategory === "1" || revision.nccnCategory === "2A") {
    ruleIds.push(NCCN_POLICY.sameTumorLevelA);
    reasonCodes.push("SAME_TUMOR_LEVEL_A_CANDIDATE");
    return { candidateLevel: "A", provisionalTier: "I", ruleIds, reasonCodes };
  }
  return { candidateLevel: null, provisionalTier: null, ruleIds, reasonCodes };
}

function step(
  order: number,
  id: string,
  label: string,
  outcome: string,
  reasonCodes: string[],
  detail: string
): NccnStep {
  return { order, id, label, outcome, reasonCodes, detail };
}

/**
 * Evaluate structured NCCN revisions in a fixed order.
 * Category is never copied into an AMP level, and no tier is finalized here.
 */
export function classifyNccn(input: NccnClassifyInput): NccnEvaluation {
  const steps: NccnStep[] = [];
  if (!input.gene || input.variantType === "OTHER") {
    steps.push(
      step(1, "validate_input", "Validate input", "stopped", ["UNSUPPORTED_VARIANT_TYPE"], "The variant type is outside the NCCN match contract.")
    );
    return {
      ruleVersion: NCCN_RULE_VERSION,
      knowledgeReleaseId: input.knowledgeReleaseId,
      classificationStatus: "not_evaluated",
      overallTier: null,
      provisionalTier: null,
      nccnMatchStatus: "not_evaluated",
      conflicts: [],
      steps,
      assertionResults: [],
    };
  }
  if (!input.tumorCode) {
    steps.push(
      step(1, "validate_input", "Validate input", "stopped", ["UNSUPPORTED_TUMOR"], "The tumor is not a pinned ontology code.")
    );
    return {
      ruleVersion: NCCN_RULE_VERSION,
      knowledgeReleaseId: input.knowledgeReleaseId,
      classificationStatus: "not_evaluated",
      overallTier: null,
      provisionalTier: null,
      nccnMatchStatus: "not_evaluated",
      conflicts: [],
      steps,
      assertionResults: [],
    };
  }

  steps.push(
    step(1, "validate_input", "Validate input", "passed", [], `${input.gene} ${input.variantType} in tumor ${input.tumorCode}.`)
  );
  steps.push(
    step(
      2,
      "fix_release",
      "Fix knowledge release",
      input.knowledgeReleaseId ? "passed" : "none",
      [],
      input.knowledgeReleaseId
        ? `Release ${input.knowledgeReleaseId}, rule ${NCCN_RULE_VERSION}.`
        : "No active NCCN knowledge release is pinned."
    )
  );

  const inactive = input.revisions.filter(
    revision => revision.status !== "active" || !inDate(revision, input.analysisAsOf)
  );
  const active = input.revisions.filter(
    revision => revision.status === "active" && inDate(revision, input.analysisAsOf)
  );
  steps.push(
    step(
      3,
      "search_assertions",
      "Search active assertions",
      active.length ? "passed" : "none",
      inactive.length ? ["EVIDENCE_INACTIVE"] : [],
      `${active.length} active revision(s). ${inactive.length} draft, rejected, or out-of-date revision(s) were left unused.`
    )
  );

  const results: NccnAssertionResult[] = [];
  for (const revision of [...active].sort((a, b) => a.assertionId.localeCompare(b.assertionId))) {
    const biomarker = biomarkerMatch(input, revision);
    const tumor = tumorMatch(input, revision);
    const excluded = biomarker.reasons.includes("VARIANT_EXCLUDED") || tumor.reasons.includes("TUMOR_EXCLUDED");
    const apply = applicability(input, revision);
    const regimen = regimenCheck(input, revision);
    const usable =
      biomarker.value === "T" &&
      (tumor.value === "T" || tumor.otherTumor) &&
      !excluded &&
      apply.value !== "F" &&
      regimen.ok;
    const candidate = usable
      ? candidateFor(revision, tumor.otherTumor)
      : { candidateLevel: null, provisionalTier: null, ruleIds: [] as string[], reasonCodes: [] as string[] };
    const reasonCodes = [
      ...biomarker.reasons,
      ...tumor.reasons,
      ...(excluded ? ["EXCLUSION_MATCHED"] : []),
      ...apply.reasons,
      ...regimen.reasons,
      ...candidate.reasonCodes,
    ];
    const ruleIds = [...candidate.ruleIds];
    if (regimen.reasons.includes("COMBINATION_NOT_SPLIT")) {
      ruleIds.push(NCCN_POLICY.combinationNotSplit);
    }
    if (apply.value === "U" && biomarker.value === "T" && tumor.value === "T") {
      reasonCodes.push("CLINICAL_SIGNIFICANCE_KEPT");
    }
    results.push({
      assertionId: revision.assertionId,
      evidenceId: revision.evidenceId,
      guidelineVersion: revision.guidelineVersion,
      location: [revision.guidelineTitle, revision.section].filter(Boolean).join(" · "),
      biomarkerMatch: biomarker.value,
      tumorMatch: tumor.otherTumor ? "F" : tumor.value,
      exclusion: excluded ? "T" : "F",
      clinicalSignificance: usable || (biomarker.value === "T" && tumor.value === "T" && apply.value === "U") ? "T" : "F",
      patientApplicability: apply.value,
      nccnCategory: usable || apply.value === "U" ? revision.nccnCategory : null,
      candidateLevel: apply.value === "U" ? candidate.candidateLevel : apply.value === "F" ? null : candidate.candidateLevel,
      provisionalTier: apply.value === "F" || !regimen.ok ? null : candidate.provisionalTier,
      reasonCodes,
      ruleIds,
      regimenId: revision.regimen?.id ?? null,
      combinationType: revision.regimen?.combinationType ?? null,
      drugIds: revision.regimen?.drugIds ?? [],
      fdaApproval: revision.approval?.fda ?? null,
      mfdsApproval: revision.approval?.mfds ?? null,
      offLabel: revision.approval?.offLabel ?? null,
      regionalApproval: revision.regionalAvailability?.approvalStatus ?? null,
    });
  }

  const matched = results.filter(
    item => item.biomarkerMatch === "T" && item.exclusion !== "T" && item.patientApplicability !== "F" && (item.tumorMatch === "T" || item.reasonCodes.includes("OTHER_TUMOR"))
  );
  const biomarkerUnknown = results.some(item => item.biomarkerMatch === "U");
  steps.push(
    step(4, "biomarker_match", "Match biomarker", matched.length ? "matched" : biomarkerUnknown ? "unknown" : "none", biomarkerUnknown ? ["FUNCTIONAL_CLASS_UNKNOWN"] : [], "Exact, curated-group, and functional-class matches are separate. Gene alone is not a match. Unknown stays unknown.")
  );
  steps.push(
    step(5, "tumor_match", "Match tumor", matched.some(item => item.tumorMatch === "T") ? "same_tumor" : matched.length ? "other_tumor" : "none", [], "Same tumor, pan-tumor, and other-tumor results stay separate.")
  );
  steps.push(
    step(6, "exclusions", "Apply exclusions", results.some(item => item.exclusion === "T") ? "excluded" : "none", [], "An excluded variant or tumor removes that revision.")
  );
  steps.push(
    step(
      7,
      "regimen_identity",
      "Resolve regimen identity",
      results.some(item => item.reasonCodes.includes("DRUG_UNMAPPED") || item.reasonCodes.includes("DRUG_IDENTITY_MISMATCH"))
        ? "review"
        : results.some(item => item.combinationType && item.combinationType !== "monotherapy")
          ? "combination"
          : "evaluated",
      results.some(item => item.reasonCodes.includes("COMBINATION_NOT_SPLIT"))
        ? [NCCN_POLICY.combinationNotSplit]
        : [],
      "A regimen is the drug set plus the combination type. A combination is not copied onto each component drug. An OncoKB name that does not map to the internal drug id is not used."
    )
  );
  steps.push(
    step(8, "clinical_conditions", "Evaluate clinical conditions", results.some(item => item.patientApplicability === "U") ? "insufficient" : "evaluated", results.some(item => item.reasonCodes.includes(NCCN_POLICY.priorTherapyByIdentity)) ? [NCCN_POLICY.priorTherapyByIdentity] : [], "Prior therapy is compared by drug id or class id. A missing history stays unknown and does not remove the clinical significance.")
  );
  steps.push(
    step(9, "evidence_validity", "Check evidence validity", "passed", [], "Only active revisions inside their validity window are used.")
  );

  const collapsed = new Set<string>();
  const kept: NccnAssertionResult[] = [];
  for (const item of matched) {
    const revision = active.find(row => row.evidenceId === item.evidenceId);
    const key = revision?.underlyingSourceKeys.slice().sort().join("|") ?? item.evidenceId;
    if (collapsed.has(key)) {
      item.reasonCodes.push("DUPLICATE_SOURCE_COLLAPSED");
      item.ruleIds.push(NCCN_POLICY.duplicateSourceCollapsed);
      continue;
    }
    collapsed.add(key);
    kept.push(item);
  }
  steps.push(
    step(10, "amp_candidate", "Propose AMP candidate", kept.some(item => item.candidateLevel) ? "review_candidate" : "none", [NCCN_POLICY.sameTumorLevelA], "NCCN category is recorded as stated. It is not copied into an AMP level. FDA or MFDS approval is recorded separately and does not set the level.")
  );
  steps.push(
    step(11, "collapse_duplicates", "Collapse duplicate sources", matched.length === kept.length ? "none" : "collapsed", [], "The same underlying source is counted once. A shared drug name is not enough to merge two regimens.")
  );

  const conflicts: string[] = [];
  const byEffect = new Map<string, Set<string>>();
  const effectsSeen = new Set<string>();
  for (const item of kept) {
    const revision = active.find(row => row.evidenceId === item.evidenceId);
    if (!revision || item.patientApplicability === "F") continue;
    effectsSeen.add(revision.effect);
    const regimenKey = revision.regimen
      ? regimenIdentity(revision.regimen)
      : "unspecified";
    const bucketKey = `${revision.domain}|${regimenKey}`;
    const bucket = byEffect.get(bucketKey) ?? new Set<string>();
    bucket.add(revision.effect);
    byEffect.set(bucketKey, bucket);
  }
  for (const [bucketKey, effects] of Array.from(byEffect.entries())) {
    if (effects.has("sensitivity") && effects.has("resistance")) {
      conflicts.push(`${bucketKey}:sensitivity_resistance`);
    }
  }
  const differentRegimens =
    !conflicts.length &&
    effectsSeen.has("sensitivity") &&
    effectsSeen.has("resistance");
  steps.push(
    step(12, "domain_results", "Summarize domains", String(byEffect.size), [], "Therapeutic, diagnostic, prognostic, and testing-only results stay in their own domains.")
  );
  steps.push(
    step(
      13,
      "conflict_check",
      "Check conflicts",
      conflicts.length ? "review_required" : "none",
      conflicts.length
        ? [NCCN_POLICY.conflictRequiresReview, "EVIDENCE_CONFLICT"]
        : differentRegimens
          ? [NCCN_POLICY.differentRegimenNotConflict]
          : [],
      conflicts.length
        ? "Opposite effects for the same regimen leave the overall tier unset."
        : "Opposite effects for different regimens are kept separate."
    )
  );

  const provisional = kept.some(item => item.provisionalTier === "I")
    ? "I"
    : kept.some(item => item.provisionalTier === "II")
      ? "II"
      : null;
  const insufficient = kept.some(item => item.patientApplicability === "U");
  const hasMatch = kept.length > 0;
  steps.push(
    step(
      14,
      "provisional_tier",
      "Set provisional tier",
      provisional ? `provisional Tier ${provisional}` : "unset",
      hasMatch
        ? []
        : biomarkerUnknown
          ? ["FUNCTIONAL_CLASS_UNKNOWN"]
          : [NCCN_POLICY.absenceDoesNotAssignTier, "NO_MATCHING_NCCN_EVIDENCE"],
      "The overall tier stays empty until a reviewer finalizes it. Absence of NCCN evidence does not assign Tier III or IV."
    )
  );

  return {
    ruleVersion: NCCN_RULE_VERSION,
    knowledgeReleaseId: input.knowledgeReleaseId,
    classificationStatus: hasMatch || conflicts.length ? "review_required" : "draft",
    overallTier: null,
    provisionalTier: provisional,
    nccnMatchStatus:
      !hasMatch && biomarkerUnknown
        ? "insufficient_information"
        : !hasMatch
          ? "no_matching_nccn_evidence"
          : insufficient
            ? "insufficient_information"
            : "matched",
    conflicts,
    steps,
    assertionResults: results,
  };
}

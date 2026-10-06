/** Structured NCCN evaluation contract. Guideline sentences are not stored here. */

export const NCCN_RULE_VERSION = "1.2.0";

export const NCCN_POLICY = {
  ruleVersion: NCCN_RULE_VERSION,
  sameTumorLevelA: "NCCN-R1",
  category2BReview: "NCCN-R2",
  category3OrDissentReview: "NCCN-R3",
  otherTumorLevelC: "NCCN-R4",
  testingOnlyCannotBeLevelA: "NCCN-R5",
  absenceDoesNotAssignTier: "NCCN-R6",
  preferenceDoesNotChangeLevel: "NCCN-R7",
  duplicateSourceCollapsed: "NCCN-R8",
  conflictRequiresReview: "NCCN-R9",
  approvalDoesNotChangeLevel: "NCCN-R10",
  combinationNotSplit: "NCCN-R11",
  differentRegimenNotConflict: "NCCN-R12",
  priorTherapyByIdentity: "NCCN-R13",
} as const;

export type Tri = "T" | "F" | "U";

export type NccnClassificationStatus =
  | "draft"
  | "review_required"
  | "finalized"
  | "not_evaluated";

export type NccnStep = {
  order: number;
  id: string;
  label: string;
  outcome: string;
  reasonCodes: string[];
  detail: string;
};

export type NccnAssertionResult = {
  assertionId: string;
  evidenceId: string;
  guidelineVersion: string;
  location: string;
  biomarkerMatch: Tri;
  tumorMatch: Tri;
  exclusion: Tri;
  clinicalSignificance: Tri;
  patientApplicability: Tri;
  nccnCategory: "1" | "2A" | "2B" | "3" | null;
  candidateLevel: "A" | "C" | null;
  provisionalTier: "I" | "II" | null;
  reasonCodes: string[];
  ruleIds: string[];
  regimenId?: string | null;
  combinationType?: "monotherapy" | "combination" | "sequential" | null;
  drugIds?: string[];
  fdaApproval?: "approved" | "not_approved" | "unknown" | null;
  mfdsApproval?: "approved" | "not_approved" | "unknown" | null;
  offLabel?: boolean | null;
  regionalApproval?: "approved" | "not_approved" | "unknown" | null;
};

export type NccnEvaluation = {
  ruleVersion: string;
  knowledgeReleaseId: string | null;
  classificationStatus: NccnClassificationStatus;
  overallTier: "I" | "II" | "III" | "IV" | null;
  provisionalTier: "I" | "II" | null;
  nccnMatchStatus:
    | "matched"
    | "no_matching_nccn_evidence"
    | "insufficient_information"
    | "not_evaluated";
  conflicts: string[];
  steps: NccnStep[];
  assertionResults: NccnAssertionResult[];
};

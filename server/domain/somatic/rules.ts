import { z } from "zod";
import type { SomaticClinicalAssertion } from "../../../drizzle/schema";
import { somaticEvidenceRecords } from "../../../drizzle/schema";
import {
  matchPinnedDisease,
  pinnedDiseaseConceptSchema,
  type PinnedDiseaseConcept,
} from "./diseaseMatch";

type SomaticEvidenceRecord = typeof somaticEvidenceRecords.$inferSelect;

export const SOMATIC_RULESET_VERSION = "amp-2017-approved-guideline-3";

export const guidelineRuleDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("somatic_amp_proposal_rule"),
    gene: z.string().trim().min(1).max(80),
    normalizedVariantId: z.string().trim().min(1).max(240).nullable().optional(),
    clinicalDomain: z.enum([
      "oncogenicity",
      "therapeutic",
      "diagnostic",
      "prognostic",
    ]),
    tumor: pinnedDiseaseConceptSchema,
    requiredDirection: z
      .enum(["supporting", "contradicting", "neutral"])
      .default("supporting"),
    systemTier: z.enum(["Tier I", "Tier II", "Tier III", "Tier IV"]),
    systemLevel: z.enum(["A", "B", "C", "D"]).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.systemTier === "Tier I" || value.systemTier === "Tier II") &&
      !value.systemLevel
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["systemLevel"],
        message: "Tier I/II guideline rules require an AMP level.",
      });
    }
    if (
      (value.systemTier === "Tier III" || value.systemTier === "Tier IV") &&
      value.systemLevel
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["systemLevel"],
        message: "Tier III/IV guideline rules cannot assign an AMP level.",
      });
    }
  });

export type ApprovedGuidelineRule = z.infer<
  typeof guidelineRuleDefinitionSchema
> & {
  recordId: number;
  recordKey: string;
  releaseId: number;
  releaseVersion: string;
  providerCode: string;
  sourceCitation: string;
};

export function parseApprovedGuidelineRule(
  guideline: unknown,
  provenance: Omit<
    ApprovedGuidelineRule,
    keyof z.infer<typeof guidelineRuleDefinitionSchema>
  >
): ApprovedGuidelineRule | null {
  const parsed = guidelineRuleDefinitionSchema.safeParse(guideline);
  return parsed.success ? { ...parsed.data, ...provenance } : null;
}

type Proposal = {
  systemTier: SomaticClinicalAssertion["systemTier"];
  systemLevel: SomaticClinicalAssertion["systemLevel"];
  rationale: string;
  conflict: boolean;
  reasonCodes: string[];
  appliedRule: {
    recordId: number;
    recordKey: string;
    releaseId: number;
    releaseVersion: string;
    providerCode: string;
    sourceCitation: string;
  } | null;
};

type ProposalContext = {
  variant: {
    gene: string | null;
    normalizedId: string;
  };
  tumor: PinnedDiseaseConcept;
  guidelineRules: ApprovedGuidelineRule[];
};

/**
 * Produce a conservative, review-only proposal.
 *
 * Source-native levels are intentionally ignored. Until an evidence record is
 * disease-matched and linked to an approved guideline/registry rule, this
 * evaluator returns no AMP Tier/Level rather than manufacturing a conversion.
 */
export function evaluateSomaticProposal(
  evidence: Array<
    Pick<
      SomaticEvidenceRecord,
      "clinicalDomain" | "direction" | "diseaseMatch" | "sourceNativeLevel"
    >
  >,
  context?: ProposalContext
): Proposal {
  if (!evidence.length) {
    return {
      systemTier: null,
      systemLevel: null,
      rationale:
        "No accepted licensed evidence was collected. Absence of a record is not evidence of benignity.",
      conflict: false,
      reasonCodes: ["no_accepted_evidence"],
      appliedRule: null,
    };
  }

  const supporting = evidence.some(item => item.direction === "supporting");
  const contradicting = evidence.some(
    item => item.direction === "contradicting"
  );
  const conflict = supporting && contradicting;
  const diseaseMatched = evidence.every(item =>
    ["exact", "manual"].includes(item.diseaseMatch)
  );
  const clinicalDomain = evidence[0]?.clinicalDomain;
  const matchingRules =
    !conflict && diseaseMatched && context && clinicalDomain
      ? context.guidelineRules.filter(
          rule =>
            rule.gene.toLocaleUpperCase() ===
              context.variant.gene?.toLocaleUpperCase() &&
            rule.clinicalDomain === clinicalDomain &&
            (!rule.normalizedVariantId ||
              rule.normalizedVariantId === context.variant.normalizedId) &&
            matchPinnedDisease(context.tumor, rule.tumor) === "exact" &&
            evidence.some(item => item.direction === rule.requiredDirection)
        )
      : [];
  const appliedRule = matchingRules.length === 1 ? matchingRules[0] : null;
  const reasonCodes = [
    ...(conflict ? ["direction_conflict"] : []),
    ...(!diseaseMatched ? ["disease_match_requires_review"] : []),
    ...(matchingRules.length > 1 ? ["multiple_guideline_rules_matched"] : []),
    ...(appliedRule
      ? ["approved_guideline_rule_applied"]
      : ["approved_guideline_rule_missing"]),
  ];

  return {
    systemTier: appliedRule?.systemTier ?? null,
    systemLevel: appliedRule?.systemLevel ?? null,
    rationale: appliedRule
      ? `Approved guideline rule ${appliedRule.recordKey} from ${appliedRule.providerCode} release ${appliedRule.releaseVersion} generated a review-only AMP proposal. Source-native evidence levels were not converted.`
      : conflict
        ? "Source-native evidence contains conflicting directions. AMP Tier/Level requires explicit expert resolution and an approved guideline rule."
        : !diseaseMatched
          ? "Source-native evidence was collected, but disease matching requires expert review. No provider level was copied into AMP."
          : matchingRules.length > 1
            ? "Multiple approved guideline rules matched. No AMP proposal was selected; expert governance review is required."
            : "Disease-matched evidence was collected, but no approved guideline rule establishes an AMP Tier/Level. Expert review is required.",
    conflict,
    reasonCodes,
    appliedRule: appliedRule
      ? {
          recordId: appliedRule.recordId,
          recordKey: appliedRule.recordKey,
          releaseId: appliedRule.releaseId,
          releaseVersion: appliedRule.releaseVersion,
          providerCode: appliedRule.providerCode,
          sourceCitation: appliedRule.sourceCitation,
        }
      : null,
  };
}

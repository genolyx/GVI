import { ACMG_CRITERIA, GERMLINE_CLASSIFICATIONS } from "../../shared/clinical-standards";

export type AcmgCode = (typeof ACMG_CRITERIA)[number];
export type GermlineClassification = (typeof GERMLINE_CLASSIFICATIONS)[number];

/**
 * ACMG 2015 evidence strengths, ordered weakest to strongest.
 *
 * Strength is a property of the applied criterion, not of its code. Richards 2015
 * §4 explicitly allows moving a criterion up or down, and the SAM-VC engine uses
 * that: it emits codes such as `PVS1_Strong` when a truncating variant escapes NMD.
 * Deriving strength from the code prefix would silently ignore those adjustments
 * and over-call pathogenicity.
 */
export const ACMG_STRENGTHS = [
  "supporting",
  "moderate",
  "strong",
  "very_strong",
  "stand_alone",
] as const;

export type AcmgStrength = (typeof ACMG_STRENGTHS)[number];

/** A criterion as applied, after any strength adjustment. */
export type AppliedCriterion = {
  code: AcmgCode | string;
  strength?: AcmgStrength | null;
};

const BENIGN_PREFIX = /^B/i;

/**
 * Read a `criteria_assessments.strengthOverride` value as a strength.
 *
 * The column is a free varchar and holds values written by both the engine
 * ("very_strong") and the UI ("Very Strong"), so normalise before comparing.
 * Returns null for absent or unrecognised values, which makes the caller fall back
 * to the code's default strength rather than silently weakening the criterion.
 */
export function toAcmgStrength(raw: string | null | undefined): AcmgStrength | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (ACMG_STRENGTHS as readonly string[]).includes(normalized)
    ? (normalized as AcmgStrength)
    : null;
}

/** Strength implied by a bare ACMG 2015 code, used when none was recorded. */
export function defaultStrengthForCode(code: string): AcmgStrength {
  const upper = code.toUpperCase();
  if (upper === "BA1") return "stand_alone";
  if (upper === "PVS1") return "very_strong";
  if (/^PS\d/.test(upper) || /^BS\d/.test(upper)) return "strong";
  if (/^PM\d/.test(upper)) return "moderate";
  return "supporting";
}

export type AcmgCounts = {
  veryStrong: number;
  strong: number;
  moderate: number;
  supporting: number;
  benignStandalone: number;
  benignStrong: number;
  benignSupporting: number;
};

export type AcmgSuggestion = {
  classification: GermlineClassification;
  rationale: string;
  conflict: boolean;
  counts: AcmgCounts;
};

function tally(criteria: readonly AppliedCriterion[]): AcmgCounts {
  const counts: AcmgCounts = {
    veryStrong: 0,
    strong: 0,
    moderate: 0,
    supporting: 0,
    benignStandalone: 0,
    benignStrong: 0,
    benignSupporting: 0,
  };

  // One code counts once. A duplicate carrying a different strength keeps the
  // stronger of the two, matching how a reviewer would read the evidence.
  const strongestByCode = new Map<string, AcmgStrength>();
  for (const criterion of criteria) {
    const code = criterion.code.toUpperCase();
    const strength = criterion.strength ?? defaultStrengthForCode(code);
    const existing = strongestByCode.get(code);
    if (!existing || ACMG_STRENGTHS.indexOf(strength) > ACMG_STRENGTHS.indexOf(existing)) {
      strongestByCode.set(code, strength);
    }
  }

  for (const [code, strength] of Array.from(strongestByCode)) {
    const benign = BENIGN_PREFIX.test(code);
    if (benign) {
      if (strength === "stand_alone") counts.benignStandalone += 1;
      else if (strength === "strong" || strength === "very_strong") counts.benignStrong += 1;
      else counts.benignSupporting += 1;
      continue;
    }
    // A pathogenic criterion promoted to stand-alone has no ACMG 2015 slot, so it
    // is counted as very strong rather than discarded.
    if (strength === "very_strong" || strength === "stand_alone") counts.veryStrong += 1;
    else if (strength === "strong") counts.strong += 1;
    else if (strength === "moderate") counts.moderate += 1;
    else counts.supporting += 1;
  }

  return counts;
}

/**
 * Suggest a germline classification from the applied criteria.
 *
 * Advisory only: the combining rules cannot capture the judgement a reviewer
 * brings, so callers present this alongside the human classification rather than
 * writing it to an approved interpretation.
 */
export function suggestAcmgClassification(
  criteria: readonly AppliedCriterion[] | readonly string[]
): AcmgSuggestion {
  const applied: AppliedCriterion[] = criteria.map(entry =>
    typeof entry === "string" ? { code: entry } : entry
  );
  const counts = tally(applied);
  const { veryStrong, strong, moderate, supporting, benignStandalone, benignStrong, benignSupporting } =
    counts;

  const hasPathogenicEvidence = veryStrong + strong + moderate + supporting > 0;
  const hasBenignEvidence = benignStandalone + benignStrong + benignSupporting > 0;

  if (hasPathogenicEvidence && hasBenignEvidence) {
    return {
      classification: "VUS",
      rationale:
        "Both pathogenic and benign evidence applied — expert review of conflicting evidence required.",
      conflict: true,
      counts,
    };
  }
  if (benignStandalone >= 1 || benignStrong >= 2) {
    return {
      classification: "Benign",
      rationale: "Meets ACMG 2015 benign combination criteria.",
      conflict: false,
      counts,
    };
  }
  if ((benignStrong >= 1 && benignSupporting >= 1) || benignSupporting >= 2) {
    return {
      classification: "Likely Benign",
      rationale: "Meets ACMG 2015 likely benign combination criteria.",
      conflict: false,
      counts,
    };
  }

  const pathogenic =
    (veryStrong >= 1 && strong >= 1) ||
    (veryStrong >= 1 && moderate >= 2) ||
    (veryStrong >= 1 && moderate >= 1 && supporting >= 1) ||
    (veryStrong >= 1 && supporting >= 2) ||
    strong >= 2 ||
    (strong >= 1 && moderate >= 3) ||
    (strong >= 1 && moderate >= 2 && supporting >= 2) ||
    (strong >= 1 && moderate >= 1 && supporting >= 4);
  if (pathogenic) {
    return {
      classification: "Pathogenic",
      rationale: "Meets ACMG 2015 pathogenic combination criteria.",
      conflict: false,
      counts,
    };
  }

  const likelyPathogenic =
    (veryStrong >= 1 && moderate >= 1) ||
    (strong >= 1 && moderate >= 1) ||
    (strong >= 1 && supporting >= 2) ||
    moderate >= 3 ||
    (moderate >= 2 && supporting >= 2) ||
    (moderate >= 1 && supporting >= 4);
  if (likelyPathogenic) {
    return {
      classification: "Likely Pathogenic",
      rationale: "Meets ACMG 2015 likely pathogenic combination criteria.",
      conflict: false,
      counts,
    };
  }

  return {
    classification: "VUS",
    rationale:
      "Selected criteria alone do not satisfy pathogenic or benign combination requirements.",
    conflict: false,
    counts,
  };
}

/** Distance between two classifications on the five-tier germline scale. */
const CLASSIFICATION_RANK: Record<GermlineClassification, number> = {
  Benign: 0,
  "Likely Benign": 1,
  VUS: 2,
  "Likely Pathogenic": 3,
  Pathogenic: 4,
};

export type ClassificationDivergence = {
  /** What the applied criteria combine to. */
  suggested: GermlineClassification;
  /** What the reviewer recorded, or null before anyone classified the variant. */
  recorded: GermlineClassification | null;
  /** True when the two disagree and the gap has not been explained. */
  diverges: boolean;
  /** How many tiers apart they are; 0 when they agree. */
  tierGap: number;
  /** Engine suggestions still awaiting a reviewer's decision. */
  pendingEngineCriteria: number;
  /** Set when signing should be blocked or warned about. */
  message: string | null;
};

/**
 * Compare the reviewer's classification with the one the criteria imply.
 *
 * Divergence is legitimate — a reviewer may know something the rules do not — but
 * it has to be visible and deliberate, so this reports rather than resolves it.
 * Reports surface the result at signing time.
 */
export function describeClassificationDivergence(
  recorded: GermlineClassification | null,
  suggestion: AcmgSuggestion,
  criteria: readonly { state: string; origin?: string | null }[] = []
): ClassificationDivergence {
  const pendingEngineCriteria = criteria.filter(
    item => item.origin === "engine" && item.state === "met"
  ).length;

  const tierGap =
    recorded === null
      ? 0
      : Math.abs(CLASSIFICATION_RANK[suggestion.classification] - CLASSIFICATION_RANK[recorded]);
  const diverges = recorded !== null && recorded !== suggestion.classification;

  let message: string | null = null;
  if (diverges) {
    message = `Reviewer recorded ${recorded} but the applied criteria combine to ${suggestion.classification}. Document the rationale before signing.`;
  } else if (suggestion.conflict) {
    message = suggestion.rationale;
  } else if (pendingEngineCriteria > 0) {
    message = `${pendingEngineCriteria} engine-suggested ${
      pendingEngineCriteria === 1 ? "criterion has" : "criteria have"
    } not been accepted or rejected yet.`;
  }

  return {
    suggested: suggestion.classification,
    recorded,
    diverges,
    tierGap,
    pendingEngineCriteria,
    message,
  };
}

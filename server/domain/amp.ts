import {
  ONCOGENICITY_CLASSIFICATIONS,
  SOMATIC_TIERS,
} from "../../shared/clinical-standards";

/**
 * AMP/ASCO/CAP 2017 somatic classification (Li et al., J Mol Diagn).
 *
 * Clinical actionability (the tier) and biological oncogenicity are separate
 * axes — a variant can be oncogenic and still Tier III if no therapy, diagnostic
 * or prognostic evidence exists for this tumour. This module never writes an
 * approved interpretation; it only suggests.
 */

export type AmpLevel = "A" | "B" | "C" | "D";
export type SomaticTier = (typeof SOMATIC_TIERS)[number];
export type Oncogenicity = (typeof ONCOGENICITY_CLASSIFICATIONS)[number];

export type AmpFact = {
  source: "CIViC" | "OncoKB" | "gnomAD" | "ClinVar";
  ampLevel: AmpLevel | null;
  clinicalDomain: "therapeutic" | "diagnostic" | "prognostic" | "oncogenicity" | "population";
  sameTumor: boolean;
  oncogenicLabel?: string | null;
  populationAf?: number | null;
  title?: string;
};

export type AmpSuggestion = {
  tier: SomaticTier;
  oncogenicity: Oncogenicity;
  rationale: string;
  conflict: boolean;
  levels: AmpLevel[];
  sourcesConsulted: string[];
  sourcesDisabled: string[];
};

const COMMON_AF = 0.05;
const POLYMORPHISM_AF = 0.01;

const ONCOKB_ONC: Record<string, Oncogenicity> = {
  oncogenic: "Oncogenic",
  "likely oncogenic": "Likely Oncogenic",
  "predicted oncogenic": "Likely Oncogenic",
  "likely neutral": "Likely Benign",
  neutral: "Benign",
  inconclusive: "VUS",
  unknown: "VUS",
  resistance: "Oncogenic",
};

/** Map an OncoKB therapeutic / Dx / Px level onto an AMP evidence level. */
export function oncokbLevelToAmp(level: string | null | undefined): AmpLevel | null {
  if (!level) return null;
  const raw = level.replace(/^LEVEL_/i, "").toUpperCase();
  if (raw === "1" || raw === "2" || raw === "R1" || raw === "DX1" || raw === "PX1") return "A";
  if (raw === "3A" || raw === "DX2" || raw === "PX2") return "B";
  if (raw === "3B" || raw === "R2" || raw === "DX3" || raw === "PX3") return "C";
  if (raw === "4") return "D";
  return null;
}

/** CIViC evidence levels A–E → AMP A–D (E is inferential, treated as D). */
export function civicLevelToAmp(level: string | null | undefined): AmpLevel | null {
  if (!level) return null;
  const letter = level.trim().toUpperCase().replace(/^LEVEL[-_\s]*/, "").charAt(0);
  if (letter === "A" || letter === "B" || letter === "C" || letter === "D") return letter;
  if (letter === "E") return "D";
  return null;
}

export function oncokbOncogenicity(label: string | null | undefined): Oncogenicity | null {
  if (!label) return null;
  return ONCOKB_ONC[label.trim().toLowerCase()] ?? null;
}

function strongestLevel(levels: AmpLevel[]): AmpLevel | null {
  for (const letter of ["A", "B", "C", "D"] as const) {
    if (levels.includes(letter)) return letter;
  }
  return null;
}

function tierFromLevel(level: AmpLevel | null, commonPolymorphism: boolean): SomaticTier {
  if (commonPolymorphism && !level) return "Tier IV";
  if (level === "A" || level === "B") return "Tier I";
  if (level === "C" || level === "D") return "Tier II";
  if (commonPolymorphism) return "Tier IV";
  return "Tier III";
}

/**
 * Combine OncoKB / CIViC / population facts into an AMP tier and oncogenicity.
 *
 * Population AF ≥ 5% with no cancer-associated evidence is Tier IV / Benign.
 * AF ≥ 1% without cancer evidence is Tier IV / Likely Benign. Actionability
 * evidence (A–D) always outranks frequency for the tier.
 */
export function suggestAmpClassification(
  facts: readonly AmpFact[],
  options: { sourcesDisabled?: string[] } = {}
): AmpSuggestion {
  const sourcesConsulted = Array.from(new Set(facts.map(fact => fact.source)));
  const actionability = facts.filter(fact => fact.ampLevel);
  const levels = actionability.map(fact => fact.ampLevel!) as AmpLevel[];
  const strongest = strongestLevel(levels);

  const af = facts.find(fact => fact.populationAf != null)?.populationAf ?? null;
  const common = af !== null && af >= COMMON_AF;
  const polymorphic = af !== null && af >= POLYMORPHISM_AF;

  const oncogenicVotes = facts
    .map(fact => oncokbOncogenicity(fact.oncogenicLabel) ?? null)
    .filter((value): value is Oncogenicity => Boolean(value));

  let oncogenicity: Oncogenicity = "VUS";
  if (oncogenicVotes.includes("Oncogenic")) oncogenicity = "Oncogenic";
  else if (oncogenicVotes.includes("Likely Oncogenic")) oncogenicity = "Likely Oncogenic";
  else if (oncogenicVotes.includes("Benign")) oncogenicity = "Benign";
  else if (oncogenicVotes.includes("Likely Benign")) oncogenicity = "Likely Benign";
  else if (common && !strongest) oncogenicity = "Benign";
  else if (polymorphic && !strongest) oncogenicity = "Likely Benign";

  const tier = tierFromLevel(strongest, common || (polymorphic && !strongest));
  const conflict = Boolean(strongest && (oncogenicity === "Benign" || oncogenicity === "Likely Benign"));

  const actionabilityBits = actionability.slice(0, 4).map(fact => {
    const tumor = fact.sameTumor ? "same tumour" : "other / unspecified tumour";
    return `${fact.source} ${fact.clinicalDomain} level ${fact.ampLevel} (${tumor})`;
  });

  const rationaleParts = [
    strongest
      ? `Strongest AMP/ASCO/CAP 2017 evidence is level ${strongest} → ${tier}.`
      : common || polymorphic
        ? `No published cancer association; population AF ${af} meets a benign-frequency threshold → ${tier}.`
        : "No published therapeutic, diagnostic or prognostic association → Tier III.",
    oncogenicVotes.length
      ? `Oncogenicity follows OncoKB/CIViC (${oncogenicity}).`
      : `Oncogenicity ${oncogenicity} from frequency and absence of a knowledge-base call.`,
    actionabilityBits.length ? `Sources: ${actionabilityBits.join("; ")}.` : null,
    conflict
      ? "Actionability and oncogenicity disagree — a reviewer must resolve the conflict before sign-out."
      : null,
  ].filter(Boolean);

  return {
    tier,
    oncogenicity,
    rationale: rationaleParts.join(" "),
    conflict,
    levels: Array.from(new Set(levels)),
    sourcesConsulted,
    sourcesDisabled: options.sourcesDisabled ?? [],
  };
}

export function describeSomaticDivergence(
  current: { somaticTier?: string | null; oncogenicity?: string | null } | null,
  suggestion: AmpSuggestion
): { diverges: boolean; message: string; tierGap: number } {
  if (!current?.somaticTier && !current?.oncogenicity) {
    return {
      diverges: false,
      tierGap: 0,
      message: "No reviewer classification yet. The AMP suggestion is advisory until a clinician accepts it.",
    };
  }
  const tierMismatch = Boolean(current.somaticTier && current.somaticTier !== suggestion.tier);
  const oncMismatch = Boolean(current.oncogenicity && current.oncogenicity !== suggestion.oncogenicity);
  if (!tierMismatch && !oncMismatch) {
    return { diverges: false, tierGap: 0, message: "" };
  }
  const bits = [
    tierMismatch ? `tier ${current.somaticTier} vs suggested ${suggestion.tier}` : null,
    oncMismatch ? `oncogenicity ${current.oncogenicity} vs suggested ${suggestion.oncogenicity}` : null,
  ].filter(Boolean);
  return {
    diverges: true,
    tierGap: (tierMismatch ? 1 : 0) + (oncMismatch ? 1 : 0),
    message: `Reviewer classification differs from the AMP/ASCO/CAP suggestion (${bits.join("; ")}).`,
  };
}

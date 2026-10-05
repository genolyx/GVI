import type { FrequencyTrack } from "@shared/germlineFrequency";

export type AlleleIdentity = {
  gene: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  clinvarSignificance?: string | null;
};

export type FrequencyContext = {
  track: FrequencyTrack;
  inheritance: ReadonlyMap<string, string>;
};

type NamedAllele = {
  gene: string;
  coding: readonly string[];
  protein: readonly string[];
};

/**
 * Mild alleles often submitted to ClinVar as plain pathogenic.
 * A pathogenic or likely pathogenic call still stays above the allele-frequency limit.
 * These alleles do not get the deep-intron or distant-UTR keep.
 */
const REDUCED_PENETRANCE: readonly NamedAllele[] = [
  { gene: "GJB2", coding: ["109g>a"], protein: ["val37ile"] },
  { gene: "HFE", coding: ["845g>a", "187c>g"], protein: ["cys282tyr", "his63asp"] },
  {
    gene: "SERPINA1",
    coding: ["1096g>a", "863a>t"],
    protein: ["glu366lys", "glu342lys", "glu288val", "glu264val"],
  },
  { gene: "G6PD", coding: ["202g>a", "376a>g"], protein: ["val68met", "asn126asp"] },
  { gene: "HEXA", coding: ["739c>t", "745c>t"], protein: ["arg247trp", "arg249trp"] },
  { gene: "ARSA", coding: ["1055a>g", "*96a>g"], protein: ["asn352ser"] },
  { gene: "CFTR", coding: ["350g>a"], protein: ["arg117his"] },
];

/** Cancer-panel alleles that stay above the frequency limit. */
const CANCER_FOUNDERS: readonly NamedAllele[] = [
  { gene: "BRCA1", coding: ["68_69del", "5266dup"], protein: [] },
  { gene: "BRCA2", coding: ["5946del"], protein: [] },
  { gene: "CHEK2", coding: ["1100del"], protein: [] },
];

const PATHOGENIC = new Set(["pathogenic", "likely pathogenic"]);
const BENIGN = new Set(["benign", "likely benign"]);

export function clinvarText(value: string | null | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

export function isReducedPenetranceCall(value: string | null | undefined): boolean {
  const text = clinvarText(value);
  return text.includes("low penetrance") || text.includes("risk allele");
}

export function clinvarTokens(value: string | null | undefined): string[] {
  const text = clinvarText(value);
  if (!text) return [];
  return text
    .split(/[&/,;|]+/)
    .map(token => token.trim())
    .filter(token => token && token !== "." && token !== "not provided");
}

/** Every ClinVar term is Pathogenic or Likely pathogenic, with no low-penetrance or risk-allele term. */
export function isPlainPathogenicCall(value: string | null | undefined): boolean {
  if (isReducedPenetranceCall(value)) return false;
  const tokens = clinvarTokens(value);
  return tokens.length > 0 && tokens.every(token => PATHOGENIC.has(token));
}

/** ClinVar includes Pathogenic or Likely pathogenic and does not include a benign term. */
export function hasClinvarPathogenicCall(value: string | null | undefined): boolean {
  const tokens = clinvarTokens(value);
  if (!tokens.some(token => PATHOGENIC.has(token))) return false;
  return !tokens.some(token => BENIGN.has(token));
}

export function combinedInheritance(labels: readonly string[]): string {
  const parts: string[] = [];
  for (const label of labels) {
    for (const part of label.split("/")) {
      if (part && !parts.includes(part)) parts.push(part);
    }
  }
  return parts.join("/");
}

/** Coding-change body used to match a named allele. Trailing del/dup bases are ignored. */
export function codingKey(value: string | null | undefined): string {
  if (!value) return "";
  const match = value.match(
    /c\.(\*?[0-9]+(?:_[0-9]+)?(?:[a-z]+>[a-z]+|del[a-z]*|dup[a-z]*|ins[a-z]*))/i
  );
  if (!match) return "";
  return match[1].toLowerCase().replace(/(del|dup|ins)[acgt]+$/, "$1");
}

export function proteinKey(value: string | null | undefined): string {
  if (!value) return "";
  const match = value.match(/p\.\(?([A-Za-z][A-Za-z0-9]*)/);
  return match ? match[1].toLowerCase() : "";
}

function matchesNamed(variant: AlleleIdentity, alleles: readonly NamedAllele[]): boolean {
  const gene = (variant.gene || "").trim().toUpperCase();
  if (!gene) return false;
  const coding = codingKey(variant.hgvsC);
  const protein = proteinKey(variant.hgvsP);
  return alleles.some(
    allele =>
      allele.gene === gene &&
      ((coding && allele.coding.includes(coding)) ||
        (protein && allele.protein.includes(protein)))
  );
}

export function isNamedReducedPenetrance(variant: AlleleIdentity): boolean {
  return matchesNamed(variant, REDUCED_PENETRANCE);
}

export function isNamedCancerFounder(variant: AlleleIdentity): boolean {
  return matchesNamed(variant, CANCER_FOUNDERS);
}

function inheritanceExemption(inheritance: string, track: FrequencyTrack): boolean {
  const parts = new Set(inheritance.split("/").filter(Boolean));
  if (parts.has("AD") || parts.has("AR")) return true;
  if (track === "hereditary_cancer") return false;
  return parts.has("X-linked");
}

/**
 * True when this allele stays beyond the intron flank or the start-codon window.
 * Inheritance still gates that keep. The allele-frequency override is separate.
 */
export function keepsBeyondFlank(
  variant: AlleleIdentity,
  context: FrequencyContext
): boolean {
  if (context.track === "none") return false;
  if (context.track === "hereditary_cancer" && isNamedCancerFounder(variant)) return true;
  if (isReducedPenetranceCall(variant.clinvarSignificance)) return false;
  if (isNamedReducedPenetrance(variant)) return false;
  if (!isPlainPathogenicCall(variant.clinvarSignificance)) return false;
  const inheritance = context.inheritance.get((variant.gene || "").trim().toUpperCase()) ?? "";
  return inheritanceExemption(inheritance, context.track);
}

/**
 * True when this allele stays even though its population frequency is above the limit.
 * On the carrier, rare-disease, and cancer tracks a ClinVar pathogenic or likely
 * pathogenic call qualifies, including a low-penetrance qualifier. A benign term,
 * a risk allele with no pathogenic term, and a blank call do not.
 */
export function keepsAtAnyFrequency(
  variant: AlleleIdentity,
  context: FrequencyContext
): boolean {
  if (context.track === "none") return false;
  if (hasClinvarPathogenicCall(variant.clinvarSignificance)) return true;
  return context.track === "hereditary_cancer" && isNamedCancerFounder(variant);
}

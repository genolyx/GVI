import type {
  CivicMolecularProfile,
  CivicVariant,
  NormalizedVariantContext,
  ProfileDisposition,
  ProfileTruth,
  VariantMatch,
} from "./types";

function normalized(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^CHR/, "")
    .replace(/^P\./, "")
    .replace(/[^A-Z0-9*]/g, "");
}

function build(value: string | null | undefined): string {
  const text = normalized(value);
  if (text.includes("37") || text.includes("19")) return "GRCH37";
  if (text.includes("38")) return "GRCH38";
  return text;
}

function exactCoordinates(
  input: NormalizedVariantContext,
  candidate: CivicVariant
): boolean {
  const coordinate = candidate.coordinates;
  if (
    !coordinate ||
    !input.genomeBuild ||
    !input.chromosome ||
    input.position === null ||
    input.position === undefined ||
    !input.ref ||
    !input.alt
  ) {
    return false;
  }
  return (
    build(input.genomeBuild) === build(coordinate.referenceBuild) &&
    normalized(input.chromosome) === normalized(coordinate.chromosome) &&
    input.position === coordinate.start &&
    normalized(input.ref) === normalized(coordinate.referenceBases) &&
    normalized(input.alt) === normalized(coordinate.variantBases)
  );
}

function proteinMatch(
  input: NormalizedVariantContext,
  candidate: CivicVariant
): boolean {
  const target = normalized(input.hgvsP);
  if (!target) return false;
  return [candidate.name, ...(candidate.hgvsDescriptions ?? [])].some(
    description => normalized(description).includes(target)
  );
}

export function matchCivicVariant(
  input: NormalizedVariantContext,
  candidate: CivicVariant
): VariantMatch {
  if (normalized(input.geneSymbol) !== normalized(candidate.feature.name)) {
    return "NONE";
  }
  if (exactCoordinates(input, candidate)) return "EXACT_ALLELE";
  if (proteinMatch(input, candidate)) return "PROTEIN_CHANGE";
  if (
    input.variantClass &&
    normalized(candidate.name).includes(normalized(input.variantClass))
  ) {
    return "VARIANT_CLASS";
  }
  const searchTerms = [input.hgvsC, input.hgvsP, input.variantClass].filter(
    (value): value is string => Boolean(value)
  );
  if (
    searchTerms.some(term =>
      normalized(candidate.name).includes(normalized(term))
    )
  ) {
    return "AMBIGUOUS";
  }
  return "NONE";
}

export type ProfileMatchResult = {
  truth: ProfileTruth;
  disposition: ProfileDisposition;
  reasons: string[];
};

/**
 * CIViC's rawName is not parsed as a Boolean expression. Until a structured
 * expression is available, any complex or multi-variant MP remains unknown.
 */
export function evaluateMolecularProfile(
  profile: CivicMolecularProfile,
  observedVariantIds: ReadonlySet<number>
): ProfileMatchResult {
  if (
    profile.isComplex ||
    profile.isMultiVariant ||
    profile.variants.length !== 1
  ) {
    return {
      truth: "UNKNOWN",
      disposition: "REVIEW_REQUIRED",
      reasons: ["COMPLEX_MOLECULAR_PROFILE_UNSUPPORTED"],
    };
  }
  const variant = profile.variants[0];
  if (variant.deprecated || profile.deprecated) {
    return {
      truth: observedVariantIds.has(variant.id) ? "TRUE" : "FALSE",
      disposition: "REVIEW_REQUIRED",
      reasons: ["DEPRECATED_PROFILE_OR_VARIANT"],
    };
  }
  return observedVariantIds.has(variant.id)
    ? { truth: "TRUE", disposition: "SUPPORTED", reasons: [] }
    : { truth: "FALSE", disposition: "SUPPORTED", reasons: [] };
}

import type { OfflineKnowledgeEvidenceInput } from "../offlineKnowledge";
import type { ProfileMatchResult } from "./matching";
import { CIVIC_QUERY_SET_SHA256 } from "./queries";
import type {
  CivicEvidenceItem,
  CivicMolecularProfile,
  NormalizedVariantContext,
  VariantMatch,
} from "./types";

export const CIVIC_ADAPTER_VERSION = "civic-graphql-v2-adapter/1";
export const CIVIC_NORMALIZATION_VERSION = "civic-eid-normalizer/1";
export const CIVIC_MATCHING_RULE_VERSION = "civic-safe-match/1";

const KNOWN_TYPES = new Set([
  "PREDICTIVE",
  "DIAGNOSTIC",
  "PROGNOSTIC",
  "ONCOGENIC",
  "FUNCTIONAL",
  "PREDISPOSING",
]);
const KNOWN_DIRECTIONS = new Set(["SUPPORTS", "DOES_NOT_SUPPORT"]);
const KNOWN_LEVELS = new Set(["A", "B", "C", "D", "E"]);
const KNOWN_SIGNIFICANCE = new Set([
  "SENSITIVITYRESPONSE",
  "RESISTANCE",
  "REDUCED_SENSITIVITY",
  "ADVERSE_RESPONSE",
  "POSITIVE",
  "NEGATIVE",
  "BETTER_OUTCOME",
  "POOR_OUTCOME",
  "NA",
]);

export type CivicNormalizedEvidence = OfflineKnowledgeEvidenceInput & {
  payload: {
    provider: "CIVIC";
    researchOnly: boolean;
    autoApplyBlockedReasons: string[];
    [key: string]: unknown;
  };
};

export type NormalizeCivicEvidenceOptions = {
  variant: NormalizedVariantContext;
  evidence: CivicEvidenceItem;
  profile: CivicMolecularProfile;
  variantMatch: VariantMatch;
  profileMatch: ProfileMatchResult;
  rawBodySha256: string;
  requestId: string;
  fetchedAt: string;
  snapshotId: string;
  schemaHash: string | null;
  doidVersion: string;
};

function normalizeDoid(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(?:DOID:)?(\d+)$/i);
  return match ? `DOID:${match[1]}` : null;
}

function clinicalDomain(
  value: string | null
): OfflineKnowledgeEvidenceInput["clinicalDomain"] {
  if (value === "PREDICTIVE") return "therapeutic";
  if (value === "DIAGNOSTIC") return "diagnostic";
  if (value === "PROGNOSTIC") return "prognostic";
  return "oncogenicity";
}

function direction(
  value: string | null,
  significance: string | null
): OfflineKnowledgeEvidenceInput["direction"] {
  if (value === "SUPPORTS" && significance === "RESISTANCE") {
    return "contradicting";
  }
  if (value === "SUPPORTS") return "supporting";
  // Lack of support is not evidence for the opposite clinical outcome.
  return "neutral";
}

function qualityReasons(options: NormalizeCivicEvidenceOptions): string[] {
  const { evidence, profile, profileMatch, variantMatch } = options;
  const reasons = [...profileMatch.reasons];
  if (evidence.flagged) reasons.push("FLAGGED_EVIDENCE");
  if (evidence.source?.retracted) reasons.push("RETRACTED_SOURCE");
  if (evidence.molecularProfile.deprecated || profile.deprecated) {
    reasons.push("DEPRECATED_MOLECULAR_PROFILE");
  }
  if (profile.variants.some(variant => variant.deprecated)) {
    reasons.push("DEPRECATED_VARIANT");
  }
  if (evidence.disease?.deprecated) reasons.push("DEPRECATED_DISEASE");
  if (evidence.therapies.some(therapy => therapy.deprecated)) {
    reasons.push("DEPRECATED_THERAPY");
  }
  if (profileMatch.disposition === "REVIEW_REQUIRED") {
    reasons.push("PROFILE_REVIEW_REQUIRED");
  }
  if (variantMatch === "AMBIGUOUS" || variantMatch === "VARIANT_CLASS") {
    reasons.push("NON_EXACT_VARIANT_MATCH");
  }
  if (variantMatch === "NONE") reasons.push("VARIANT_NOT_MATCHED");
  if (!evidence.evidenceType || !KNOWN_TYPES.has(evidence.evidenceType)) {
    reasons.push("UNKNOWN_EVIDENCE_TYPE");
  }
  if (
    !evidence.evidenceDirection ||
    !KNOWN_DIRECTIONS.has(evidence.evidenceDirection)
  ) {
    reasons.push("UNKNOWN_EVIDENCE_DIRECTION");
  }
  if (
    evidence.evidenceLevel !== null &&
    !KNOWN_LEVELS.has(evidence.evidenceLevel)
  ) {
    reasons.push("UNKNOWN_EVIDENCE_LEVEL");
  }
  if (
    !evidence.clinicalSignificance ||
    !KNOWN_SIGNIFICANCE.has(evidence.clinicalSignificance)
  ) {
    reasons.push("UNKNOWN_CLINICAL_SIGNIFICANCE");
  }
  if (!evidence.disease) reasons.push("MISSING_DISEASE");
  if (!evidence.source) reasons.push("MISSING_SOURCE");
  return Array.from(new Set(reasons)).sort();
}

/**
 * Returns null for non-Accepted records. The caller must not treat null as an
 * upstream empty result; it is a post-fetch curation-status rejection.
 */
export function normalizeAcceptedEvidence(
  options: NormalizeCivicEvidenceOptions
): CivicNormalizedEvidence | null {
  const { evidence, profile } = options;
  if (evidence.status !== "ACCEPTED") return null;
  const doid = normalizeDoid(evidence.disease?.doid);
  const blockedReasons = qualityReasons(options);
  if (!doid) blockedReasons.push("DISEASE_DOID_UNKNOWN");
  const uniqueReasons = Array.from(new Set(blockedReasons)).sort();
  const therapies = evidence.therapies.map(therapy => ({
    civicId: therapy.id,
    name: therapy.name,
    ncitId: therapy.ncitId,
    deprecated: therapy.deprecated,
  }));
  const sourceUrl = evidence.link ?? evidence.source?.sourceUrl ?? null;

  return {
    normalizedVariantId: options.variant.normalizedVariantId,
    sourceRecordId: String(evidence.id),
    sourceNativeLevel: evidence.evidenceLevel,
    clinicalDomain: clinicalDomain(evidence.evidenceType),
    direction: direction(
      evidence.evidenceDirection,
      evidence.clinicalSignificance
    ),
    diseaseOntology: {
      ontologySystem: "DOID",
      ontologyVersion: options.doidVersion,
      code: doid ?? "UNKNOWN",
    },
    summary:
      evidence.description?.trim() ||
      `CIViC evidence item ${evidence.id}; description unavailable.`,
    sourceUrl,
    rawResponseHash: options.rawBodySha256.toLowerCase(),
    payload: {
      provider: "CIVIC",
      sourceRecordType: "EVIDENCE_ITEM",
      sourceRecordId: String(evidence.id),
      status: evidence.status,
      evidenceTypeRaw: evidence.evidenceType,
      evidenceDomain: clinicalDomain(evidence.evidenceType),
      civicEvidenceLevel: evidence.evidenceLevel,
      evidenceRating: evidence.evidenceRating,
      evidenceDirectionRaw: evidence.evidenceDirection,
      clinicalSignificanceRaw: evidence.clinicalSignificance,
      variantOriginRaw: evidence.variantOrigin,
      disease: evidence.disease
        ? {
            civicId: evidence.disease.id,
            name: evidence.disease.name,
            doidRaw: evidence.disease.doid,
            doid,
            deprecated: evidence.disease.deprecated,
          }
        : null,
      therapies,
      therapyInteractionRaw: evidence.therapyInteractionType,
      therapySetSemantics: "PRESERVE_AS_SINGLE_EVIDENCE_CONTEXT",
      source: evidence.source
        ? {
            civicId: evidence.source.id,
            sourceType: evidence.source.sourceType,
            citationId: evidence.source.citationId,
            citation: evidence.source.citation,
            sourceUrl: evidence.source.sourceUrl,
            retracted: evidence.source.retracted,
          }
        : null,
      molecularProfile: {
        civicId: profile.id,
        name: profile.name,
        rawName: profile.rawName,
        isComplex: profile.isComplex,
        isMultiVariant: profile.isMultiVariant,
        deprecated: profile.deprecated,
        variants: profile.variants,
        truth: options.profileMatch.truth,
        disposition: options.profileMatch.disposition,
      },
      matching: {
        variantMatch: options.variantMatch,
        profileMatch: options.profileMatch,
      },
      quality: {
        flagged: evidence.flagged,
        openRevisionCount: evidence.openRevisionCount,
        sourceRetracted: evidence.source?.retracted ?? null,
        unknownFields: uniqueReasons.filter(reason =>
          reason.startsWith("UNKNOWN_")
        ),
      },
      acceptanceEvent: evidence.acceptanceEvent,
      lastAcceptedRevisionEvent: evidence.lastAcceptedRevisionEvent,
      researchOnly: uniqueReasons.length > 0,
      autoApplyBlockedReasons: uniqueReasons,
      provenance: {
        requestId: options.requestId,
        fetchedAt: options.fetchedAt,
        snapshotId: options.snapshotId,
        rawBodySha256: options.rawBodySha256,
        schemaHash: options.schemaHash,
        queryHash: CIVIC_QUERY_SET_SHA256,
        adapterVersion: CIVIC_ADAPTER_VERSION,
        normalizationVersion: CIVIC_NORMALIZATION_VERSION,
        matchingRuleVersion: CIVIC_MATCHING_RULE_VERSION,
      },
      internalClassification: {
        framework: "AMP_ASCO_CAP_2017",
        tier: null,
        level: null,
        status: "NOT_EVALUATED",
      },
    },
  };
}

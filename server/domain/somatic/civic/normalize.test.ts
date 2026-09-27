import { describe, expect, it } from "vitest";
import { evaluateMolecularProfile, matchCivicVariant } from "./matching";
import { normalizeAcceptedEvidence } from "./normalize";
import {
  ACCEPTED_EVIDENCE_QUERY,
  CIVIC_OPERATIONS,
  CIVIC_QUERY_SET_SHA256,
} from "./queries";
import type {
  CivicEvidenceItem,
  CivicMolecularProfile,
  CivicVariant,
  NormalizedVariantContext,
} from "./types";

const input: NormalizedVariantContext = {
  normalizedVariantId: "GRCh38:7:140753336:A:T",
  geneSymbol: "BRAF",
  genomeBuild: "GRCh38",
  chromosome: "7",
  position: 140753336,
  ref: "A",
  alt: "T",
  hgvsP: "p.Val600Glu",
  variantClass: "missense",
};

function candidate(overrides: Partial<CivicVariant> = {}): CivicVariant {
  return {
    __typename: "GeneVariant",
    id: 12,
    name: "V600E",
    deprecated: false,
    variantAliases: [],
    feature: { id: 5, name: "BRAF", featureType: "GENE" },
    hgvsDescriptions: ["NM_004333.6:p.Val600Glu"],
    coordinates: {
      chromosome: "7",
      start: 140753336,
      referenceBases: "A",
      variantBases: "T",
      referenceBuild: "GRCh38",
    },
    ...overrides,
  };
}

function profile(
  overrides: Partial<CivicMolecularProfile> = {}
): CivicMolecularProfile {
  return {
    id: 20,
    name: "BRAF V600E",
    rawName: "BRAF V600E",
    isComplex: false,
    isMultiVariant: false,
    deprecated: false,
    variants: [
      {
        id: 12,
        name: "V600E",
        deprecated: false,
        feature: { id: 5, name: "BRAF" },
      },
    ],
    ...overrides,
  };
}

function evidence(
  overrides: Partial<CivicEvidenceItem> = {}
): CivicEvidenceItem {
  return {
    id: 99,
    link: "https://civicdb.org/evidence/99",
    status: "ACCEPTED",
    evidenceType: "PREDICTIVE",
    evidenceLevel: "B",
    evidenceRating: 4,
    evidenceDirection: "SUPPORTS",
    clinicalSignificance: "SENSITIVITYRESPONSE",
    description: "Combined therapy response evidence.",
    variantOrigin: "SOMATIC",
    flagged: false,
    openRevisionCount: 0,
    molecularProfile: { id: 20, name: "BRAF V600E", deprecated: false },
    disease: {
      id: 7,
      name: "Melanoma",
      doid: "DOID:1909",
      deprecated: false,
    },
    therapies: [
      { id: 1, name: "Drug A", ncitId: "C1", deprecated: false },
      { id: 2, name: "Drug B", ncitId: "C2", deprecated: false },
    ],
    therapyInteractionType: "COMBINATION",
    source: {
      id: 10,
      sourceType: "PUBMED",
      citationId: "12345",
      citation: "Example et al.",
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/12345",
      retracted: false,
    },
    acceptanceEvent: { id: 100, createdAt: "2026-01-01T00:00:00Z" },
    lastAcceptedRevisionEvent: {
      id: 101,
      createdAt: "2026-02-01T00:00:00Z",
    },
    ...overrides,
  };
}

function normalize(overrides: Partial<CivicEvidenceItem> = {}) {
  const mp = profile();
  return normalizeAcceptedEvidence({
    variant: input,
    evidence: evidence(overrides),
    profile: mp,
    variantMatch: "EXACT_ALLELE",
    profileMatch: evaluateMolecularProfile(mp, new Set([12])),
    rawBodySha256: "a".repeat(64),
    requestId: "request-1",
    fetchedAt: "2026-09-27T00:00:00.000Z",
    snapshotId: "snapshot-1",
    schemaHash: "b".repeat(64),
    doidVersion: "2026-09",
  });
}

describe("CIViC matching and normalization", () => {
  it("fixes all operations, Accepted filtering, and query-set hash", () => {
    expect(Object.keys(CIVIC_OPERATIONS).sort()).toEqual([
      "AcceptedEvidence",
      "CandidateProfiles",
      "CandidateVariants",
      "CheckEvidenceContract",
      "ResolveGene",
      "VariantDetail",
    ]);
    expect(ACCEPTED_EVIDENCE_QUERY).toMatch(/status:\s*ACCEPTED/);
    expect(ACCEPTED_EVIDENCE_QUERY).toContain(
      "clinicalSignificance: significance"
    );
    expect(CIVIC_QUERY_SET_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires corroborated coordinates for exact allele matching", () => {
    expect(matchCivicVariant(input, candidate())).toBe("EXACT_ALLELE");
    expect(
      matchCivicVariant(
        input,
        candidate({
          coordinates: {
            ...candidate().coordinates!,
            referenceBuild: "GRCh37",
          },
        })
      )
    ).toBe("PROTEIN_CHANGE");
    expect(
      matchCivicVariant(
        { ...input, hgvsP: null },
        candidate({ coordinates: null, name: "BRAF mutation" })
      )
    ).not.toBe("EXACT_ALLELE");
  });

  it("marks complex molecular profiles UNKNOWN and review-required", () => {
    const result = evaluateMolecularProfile(
      profile({
        isComplex: true,
        isMultiVariant: true,
        rawName: "BRAF V600E AND NOT PTEN loss",
      }),
      new Set([12])
    );
    expect(result).toEqual({
      truth: "UNKNOWN",
      disposition: "REVIEW_REQUIRED",
      reasons: ["COMPLEX_MOLECULAR_PROFILE_UNSUPPORTED"],
    });
  });

  it("accepts only ACCEPTED EIDs and preserves domains and therapy context", () => {
    expect(normalize({ status: "REJECTED" })).toBeNull();
    const result = normalize()!;
    expect(result).toMatchObject({
      clinicalDomain: "therapeutic",
      direction: "supporting",
      diseaseOntology: {
        ontologySystem: "DOID",
        ontologyVersion: "2026-09",
        code: "DOID:1909",
      },
      payload: {
        evidenceTypeRaw: "PREDICTIVE",
        civicEvidenceLevel: "B",
        evidenceRating: 4,
        evidenceDirectionRaw: "SUPPORTS",
        clinicalSignificanceRaw: "SENSITIVITYRESPONSE",
        variantOriginRaw: "SOMATIC",
        therapyInteractionRaw: "COMBINATION",
        therapySetSemantics: "PRESERVE_AS_SINGLE_EVIDENCE_CONTEXT",
        researchOnly: false,
        autoApplyBlockedReasons: [],
        internalClassification: {
          tier: null,
          level: null,
          status: "NOT_EVALUATED",
        },
      },
    });
    expect(result.payload.therapies).toEqual([
      { civicId: 1, name: "Drug A", ncitId: "C1", deprecated: false },
      { civicId: 2, name: "Drug B", ncitId: "C2", deprecated: false },
    ]);
    expect(result.payload).not.toHaveProperty("ampLevel");
    expect(result.payload).not.toHaveProperty("ampTier");
  });

  it("keeps DOES_NOT_SUPPORT sensitivity and resistance neutral", () => {
    for (const significance of ["SENSITIVITYRESPONSE", "RESISTANCE"]) {
      const result = normalize({
        evidenceDirection: "DOES_NOT_SUPPORT",
        clinicalSignificance: significance,
      })!;
      expect(result.direction).toBe("neutral");
      expect(result.payload).toMatchObject({
        evidenceDirectionRaw: "DOES_NOT_SUPPORT",
        clinicalSignificanceRaw: significance,
      });
    }
    expect(normalize({ evidenceType: "DIAGNOSTIC" })!.clinicalDomain).toBe(
      "diagnostic"
    );
    expect(normalize({ evidenceType: "PROGNOSTIC" })!.clinicalDomain).toBe(
      "prognostic"
    );
    expect(
      normalize({
        evidenceDirection: "SUPPORTS",
        clinicalSignificance: "RESISTANCE",
      })!.direction
    ).toBe("contradicting");
  });

  it("blocks flagged, retracted, deprecated, complex, and unknown evidence", () => {
    const mp = profile({ isComplex: true, deprecated: true });
    const item = evidence({
      flagged: true,
      evidenceType: "NEW_DOMAIN",
      disease: { ...evidence().disease!, deprecated: true },
      therapies: [{ ...evidence().therapies[0], deprecated: true }],
      source: { ...evidence().source!, retracted: true },
      molecularProfile: { id: 20, name: "complex", deprecated: true },
    });
    const result = normalizeAcceptedEvidence({
      variant: input,
      evidence: item,
      profile: mp,
      variantMatch: "AMBIGUOUS",
      profileMatch: evaluateMolecularProfile(mp, new Set([12])),
      rawBodySha256: "c".repeat(64),
      requestId: "request-2",
      fetchedAt: "2026-09-27T00:00:00.000Z",
      snapshotId: "snapshot-2",
      schemaHash: null,
      doidVersion: "2026-09",
    })!;
    expect(result.payload.researchOnly).toBe(true);
    expect(result.payload.autoApplyBlockedReasons).toEqual(
      expect.arrayContaining([
        "FLAGGED_EVIDENCE",
        "RETRACTED_SOURCE",
        "DEPRECATED_MOLECULAR_PROFILE",
        "DEPRECATED_DISEASE",
        "DEPRECATED_THERAPY",
        "COMPLEX_MOLECULAR_PROFILE_UNSUPPORTED",
        "PROFILE_REVIEW_REQUIRED",
        "NON_EXACT_VARIANT_MATCH",
        "UNKNOWN_EVIDENCE_TYPE",
      ])
    );
  });
});

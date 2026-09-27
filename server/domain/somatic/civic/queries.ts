import { createHash } from "node:crypto";

export const RESOLVE_GENE_QUERY = `query ResolveGene($symbol: String!) {
  gene(entrezSymbol: $symbol) {
    id
    name
    entrezId
    featureAliases
    deprecated
  }
}`;

export const CANDIDATE_VARIANTS_QUERY = `query CandidateVariants($geneId: Int!, $name: String!, $after: String) {
  variants(geneId: $geneId, name: $name, first: 25, after: $after) {
    nodes {
      __typename
      id
      name
      deprecated
      variantAliases
      feature { id name featureType }
      ... on GeneVariant {
        alleleRegistryId
        hgvsDescriptions
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const VARIANT_DETAIL_QUERY = `query VariantDetail($variantId: Int!) {
  variant(id: $variantId) {
    __typename
    id
    name
    deprecated
    variantAliases
    feature { id name featureType }
    ... on GeneVariant {
      alleleRegistryId
      hgvsDescriptions
      coordinates {
        chromosome
        start
        referenceBases
        variantBases
        referenceBuild
      }
    }
  }
}`;

export const CANDIDATE_PROFILES_QUERY = `query CandidateProfiles($variantId: Int!, $after: String) {
  molecularProfiles(variantId: $variantId, first: 25, after: $after) {
    nodes {
      id
      name
      rawName
      isComplex
      isMultiVariant
      deprecated
      variants {
        id
        name
        deprecated
        feature { id name }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ACCEPTED_EVIDENCE_QUERY = `query AcceptedEvidence($mpId: Int!, $first: Int!, $after: String) {
  evidenceItems(
    molecularProfileId: $mpId
    status: ACCEPTED
    first: $first
    after: $after
  ) {
    totalCount
    nodes {
      id
      link
      status
      evidenceType
      evidenceLevel
      evidenceRating
      evidenceDirection
      clinicalSignificance: significance
      description
      variantOrigin
      flagged
      openRevisionCount
      molecularProfile { id name deprecated }
      disease { id name doid deprecated }
      therapies { id name ncitId deprecated }
      therapyInteractionType
      source {
        id
        sourceType
        citationId
        citation
        sourceUrl
        retracted
      }
      acceptanceEvent { id createdAt }
      lastAcceptedRevisionEvent { id createdAt }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const CHECK_EVIDENCE_CONTRACT_QUERY = `query CheckEvidenceContract {
  evidence: __type(name: "EvidenceItem") {
    fields(includeDeprecated: true) {
      name
      isDeprecated
      deprecationReason
      type { kind name ofType { kind name } }
    }
  }
  significance: __type(name: "EvidenceSignificance") {
    enumValues { name }
  }
}`;

export const CIVIC_OPERATIONS = Object.freeze({
  ResolveGene: RESOLVE_GENE_QUERY,
  CandidateVariants: CANDIDATE_VARIANTS_QUERY,
  VariantDetail: VARIANT_DETAIL_QUERY,
  CandidateProfiles: CANDIDATE_PROFILES_QUERY,
  AcceptedEvidence: ACCEPTED_EVIDENCE_QUERY,
  CheckEvidenceContract: CHECK_EVIDENCE_CONTRACT_QUERY,
});

export type CivicOperationName = keyof typeof CIVIC_OPERATIONS;

export const CIVIC_QUERY_SET_SHA256 = createHash("sha256")
  .update(
    Object.entries(CIVIC_OPERATIONS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, query]) => `${name}\0${query}`)
      .join("\0")
  )
  .digest("hex");

export type ProviderState =
  | "COMPLETE"
  | "NO_MATCH"
  | "NO_EVIDENCE"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "REVIEW_REQUIRED";

export type CivicPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type CivicGene = {
  id: number;
  name: string;
  entrezId: number | null;
  featureAliases: string[];
  deprecated: boolean;
};

export type CivicFeature = {
  id: number;
  name: string;
  featureType?: string | null;
};

export type CivicCoordinate = {
  chromosome: string;
  start: number;
  referenceBases: string;
  variantBases: string;
  referenceBuild: string;
};

export type CivicVariant = {
  __typename: string;
  id: number;
  name: string;
  deprecated: boolean;
  variantAliases: string[];
  feature: CivicFeature;
  alleleRegistryId?: string | null;
  hgvsDescriptions?: string[] | null;
  coordinates?: CivicCoordinate | null;
};

export type CivicMolecularProfile = {
  id: number;
  name: string;
  rawName: string;
  isComplex: boolean;
  isMultiVariant: boolean;
  deprecated: boolean;
  variants: Array<
    Pick<CivicVariant, "id" | "name" | "deprecated"> & {
      feature: Pick<CivicFeature, "id" | "name">;
    }
  >;
};

export type CivicDisease = {
  id: number;
  name: string;
  doid: string | null;
  deprecated: boolean;
};

export type CivicTherapy = {
  id: number;
  name: string;
  ncitId: string | null;
  deprecated: boolean;
};

export type CivicSource = {
  id: number;
  sourceType: string;
  citationId: string | null;
  citation: string | null;
  sourceUrl: string | null;
  retracted: boolean;
};

export type CivicEvidenceItem = {
  id: number;
  link: string | null;
  status: string;
  evidenceType: string | null;
  evidenceLevel: string | null;
  evidenceRating: number | null;
  evidenceDirection: string | null;
  clinicalSignificance: string | null;
  description: string | null;
  variantOrigin: string | null;
  flagged: boolean;
  openRevisionCount: number;
  molecularProfile: Pick<CivicMolecularProfile, "id" | "name" | "deprecated">;
  disease: CivicDisease | null;
  therapies: CivicTherapy[];
  therapyInteractionType: string | null;
  source: CivicSource | null;
  acceptanceEvent: { id: number; createdAt: string } | null;
  lastAcceptedRevisionEvent: { id: number; createdAt: string } | null;
};

export type GraphQlErrorWire = {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};

export type GraphQlEnvelope<T> = {
  data?: T | null;
  errors?: GraphQlErrorWire[];
};

export type RawResponseEnvelope = {
  requestId: string;
  provider: "CIVIC";
  endpoint: string;
  operationName: string;
  querySha256: string;
  requestedAtUTC: string;
  receivedAtUTC: string;
  durationMs: number;
  httpStatus: number | null;
  contentType: string | null;
  safeResponseHeaders: Record<string, string>;
  responseByteLength: number;
  bodySha256: string | null;
  graphqlErrors: GraphQlErrorWire[];
  cacheHit: boolean;
};

export type NormalizedVariantContext = {
  normalizedVariantId: string;
  geneSymbol: string;
  genomeBuild?: string | null;
  chromosome?: string | null;
  position?: number | null;
  ref?: string | null;
  alt?: string | null;
  transcript?: string | null;
  hgvsC?: string | null;
  hgvsP?: string | null;
  variantClass?: string | null;
};

export type VariantMatch =
  | "EXACT_ALLELE"
  | "PROTEIN_CHANGE"
  | "VARIANT_CLASS"
  | "AMBIGUOUS"
  | "NONE";

export type ProfileTruth = "TRUE" | "FALSE" | "UNKNOWN";
export type ProfileDisposition = "SUPPORTED" | "REVIEW_REQUIRED";

export type CivicErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "NETWORK"
  | "GRAPHQL_VALIDATION"
  | "GRAPHQL_ERROR"
  | "PROTOCOL"
  | "DEADLINE"
  | "CURSOR_NOT_ADVANCING"
  | "PAGE_LIMIT";

export type CivicProviderError = {
  code: CivicErrorCode;
  retryable: boolean;
  requestId: string;
  message: string;
};

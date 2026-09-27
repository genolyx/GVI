import { createHash } from "node:crypto";
import type { Variant } from "../../../drizzle/schema";
import { loadCivicEvidence, type SomaticEvidenceDraft } from "../somaticKb";

export type NormalizedSomaticEvidence = {
  sourceName: string;
  sourceVersion: string;
  sourceRecordId: string;
  sourceNativeLevel: string | null;
  clinicalDomain: SomaticEvidenceDraft["clinicalDomain"];
  direction: SomaticEvidenceDraft["direction"];
  diseaseMatch:
    | "exact"
    | "broader"
    | "narrower"
    | "none"
    | "unknown"
    | "manual";
  summary: string;
  sourceUrl: string | null;
  rawResponseHash: string;
  retrievedAt: Date;
  payload: Record<string, unknown>;
};

export type SomaticEvidenceCollection = {
  records: NormalizedSomaticEvidence[];
  unavailable: string[];
};

export type SomaticTumorContext =
  | string
  | {
      label: string;
      ontologySystem: string;
      ontologyVersion: string;
      code: string;
    };

/**
 * Evidence is injected into the run processor so deterministic fixtures can be
 * used by tests and scripts without exposing them through production tRPC.
 */
export interface SomaticEvidenceProvider {
  readonly knowledgeVersions: Readonly<Record<string, string>>;
  collect(
    variant: Variant,
    tumor: SomaticTumorContext
  ): Promise<SomaticEvidenceCollection>;
  collectBatch?(
    variants: Variant[],
    tumor: SomaticTumorContext
  ): Promise<Map<string, SomaticEvidenceCollection>>;
}

const DERIVED_CLASSIFICATION_FIELDS = new Set([
  "ampLevel",
  "ampTier",
  "systemLevel",
  "systemTier",
  "finalLevel",
  "finalTier",
  "sameTumor",
]);

/**
 * Keep the provider response available for provenance while ensuring that
 * provider-derived classification fields cannot enter the AMP namespace.
 */
export function preserveSourceNativePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => !DERIVED_CLASSIFICATION_FIELDS.has(key)
    )
  );
}

/**
 * Phase-1 clinical provider registry.
 *
 * CIViC is enabled as an evidence provider. OncoKB is deliberately absent from
 * this registry until the deployment has explicit clinical-use rights. Provider
 * levels are preserved verbatim and are never converted into AMP levels here.
 */
export const liveSomaticEvidenceProvider: SomaticEvidenceProvider = {
  knowledgeVersions: {
    CIViC: "live",
    OncoKB: "disabled_pending_clinical_license",
  },
  async collect(variant, tumor) {
    const retrievedAt = new Date();
    try {
      const tumorLabel = typeof tumor === "string" ? tumor : tumor.label;
      const drafts = await loadCivicEvidence(variant, tumorLabel);
      return {
        records: drafts.map((draft, index) => {
          const sourceRecordId =
            draft.sourceRecordId ||
            `${variant.normalizedId}:civic:${index + 1}`;
          const raw = JSON.stringify({
            sourceRecordId,
            evidenceLevel: draft.evidenceLevel,
            payload: draft.payload,
          });
          return {
            sourceName: "CIViC",
            // CIViC's live API does not expose a release in this response. The
            // retrieval timestamp and raw hash freeze exactly what was consumed.
            sourceVersion: "live",
            sourceRecordId,
            sourceNativeLevel: draft.evidenceLevel,
            clinicalDomain: draft.clinicalDomain,
            direction: draft.direction,
            // Token overlap is not a clinically safe ontology match.
            diseaseMatch: "unknown",
            summary: draft.excerpt || draft.title,
            sourceUrl: draft.url,
            rawResponseHash: createHash("sha256").update(raw).digest("hex"),
            retrievedAt,
            payload: {
              ...preserveSourceNativePayload(draft.payload),
              diseaseMatchRequiresReview: true,
            },
          };
        }),
        unavailable: [],
      };
    } catch {
      return { records: [], unavailable: ["CIViC"] };
    }
  },
};

/** @deprecated Use liveSomaticEvidenceProvider.collect at explicit call sites. */
export function collectLicensedSomaticEvidence(
  variant: Variant,
  tumorLabel: SomaticTumorContext
): Promise<SomaticEvidenceCollection> {
  return liveSomaticEvidenceProvider.collect(variant, tumorLabel);
}

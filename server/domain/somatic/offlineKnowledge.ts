import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  somaticKnowledgeEvidenceRecords,
  somaticKnowledgeProviders,
  somaticKnowledgeReleases,
  somaticOrganizationPolicyProfiles,
} from "../../../drizzle/schema";
import { requireDb } from "../tenant";
import { pinnedDiseaseConceptSchema } from "./diseaseMatch";
import { createOncoKbApiProvider, oncoKbApiConfigFromEnv } from "./oncokbApi";
import {
  preserveSourceNativePayload,
  type NormalizedSomaticEvidence,
  type SomaticEvidenceProvider,
  type SomaticTumorContext,
} from "./provider";

export const offlineKnowledgeEvidenceSchema = z
  .object({
    normalizedVariantId: z.string().trim().min(1).max(240),
    sourceRecordId: z.string().trim().min(1).max(200),
    sourceNativeLevel: z.string().trim().min(1).max(80).nullable(),
    clinicalDomain: z.enum([
      "oncogenicity",
      "therapeutic",
      "diagnostic",
      "prognostic",
    ]),
    direction: z.enum(["supporting", "contradicting", "neutral"]),
    diseaseOntology: pinnedDiseaseConceptSchema,
    summary: z.string().trim().min(1).max(20_000),
    sourceUrl: z.string().url().max(1000).nullable(),
    rawResponseHash: z.string().regex(/^[a-f0-9]{64}$/i),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type OfflineKnowledgeEvidenceInput = z.infer<
  typeof offlineKnowledgeEvidenceSchema
>;

type DiffRecord = {
  normalizedVariantId: string;
  sourceRecordId: string;
  rawResponseHash: string;
};

export type KnowledgeReleaseDiff = {
  added: number;
  removed: number;
  changed: number;
  impactedVariantIds: string[];
};

export function diffKnowledgeReleaseRecords(
  previous: DiffRecord[],
  target: DiffRecord[]
): KnowledgeReleaseDiff {
  const before = new Map(
    previous.map(record => [record.sourceRecordId, record])
  );
  const after = new Map(target.map(record => [record.sourceRecordId, record]));
  const impacted = new Set<string>();
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const [id, record] of Array.from(after.entries())) {
    const prior = before.get(id);
    if (!prior) {
      added += 1;
      impacted.add(record.normalizedVariantId);
    } else if (
      prior.rawResponseHash !== record.rawResponseHash ||
      prior.normalizedVariantId !== record.normalizedVariantId
    ) {
      changed += 1;
      impacted.add(prior.normalizedVariantId);
      impacted.add(record.normalizedVariantId);
    }
  }
  for (const [id, record] of Array.from(before.entries())) {
    if (!after.has(id)) {
      removed += 1;
      impacted.add(record.normalizedVariantId);
    }
  }

  return {
    added,
    removed,
    changed,
    impactedVariantIds: Array.from(impacted).sort(),
  };
}

export function offlineEvidenceInsertValues(
  organizationId: number,
  releaseId: number,
  record: OfflineKnowledgeEvidenceInput
) {
  return {
    organizationId,
    releaseId,
    normalizedVariantId: record.normalizedVariantId,
    sourceRecordId: record.sourceRecordId,
    sourceNativeLevel: record.sourceNativeLevel,
    clinicalDomain: record.clinicalDomain,
    direction: record.direction,
    summary: record.summary,
    sourceUrl: record.sourceUrl,
    rawResponseHash: record.rawResponseHash.toLowerCase(),
    payload: {
      ...preserveSourceNativePayload(record.payload),
      diseaseOntology: record.diseaseOntology,
    },
  };
}

/**
 * Build a production provider from one validated active offline release.
 * CIViC remains offline/version-pinned. OncoKB is an explicitly governed API
 * provider and never acts as a fallback for missing CIViC data.
 */
export async function createOrganizationSomaticEvidenceProvider(
  organizationId: number,
  providerCode = "CIVIC"
): Promise<SomaticEvidenceProvider> {
  const db = await requireDb();
  const [releaseRows, providerRows, policyRows] = await Promise.all([
    db
      .select({
        release: somaticKnowledgeReleases,
        provider: somaticKnowledgeProviders,
      })
      .from(somaticKnowledgeReleases)
      .innerJoin(
        somaticKnowledgeProviders,
        and(
          eq(somaticKnowledgeProviders.id, somaticKnowledgeReleases.providerId),
          eq(
            somaticKnowledgeProviders.organizationId,
            somaticKnowledgeReleases.organizationId
          )
        )
      )
      .where(
        and(
          eq(somaticKnowledgeReleases.organizationId, organizationId),
          eq(somaticKnowledgeReleases.status, "active"),
          eq(somaticKnowledgeReleases.validationStatus, "passed"),
          eq(somaticKnowledgeProviders.enabled, true),
          eq(somaticKnowledgeProviders.licenseStatus, "approved")
        )
      ),
    db
      .select()
      .from(somaticKnowledgeProviders)
      .where(eq(somaticKnowledgeProviders.organizationId, organizationId)),
    db
      .select()
      .from(somaticOrganizationPolicyProfiles)
      .where(
        and(
          eq(somaticOrganizationPolicyProfiles.organizationId, organizationId),
          eq(somaticOrganizationPolicyProfiles.status, "active")
        )
      )
      .limit(1),
  ]);
  const selected = releaseRows.find(
    row => row.provider.code.toLocaleUpperCase() === providerCode
  );
  const civicProvider: SomaticEvidenceProvider = selected
    ? {
        knowledgeVersions: {
          [selected.provider.code]: selected.release.version,
        },
        async collect(variant) {
          const rows = await db
            .select()
            .from(somaticKnowledgeEvidenceRecords)
            .where(
              and(
                eq(
                  somaticKnowledgeEvidenceRecords.organizationId,
                  organizationId
                ),
                eq(
                  somaticKnowledgeEvidenceRecords.releaseId,
                  selected.release.id
                ),
                eq(
                  somaticKnowledgeEvidenceRecords.normalizedVariantId,
                  variant.normalizedId
                )
              )
            );
          const acceptedDomains = new Set([
            "oncogenicity",
            "therapeutic",
            "diagnostic",
            "prognostic",
          ]);
          const records: NormalizedSomaticEvidence[] = rows.flatMap(row =>
            acceptedDomains.has(row.clinicalDomain)
              ? [
                  {
                    sourceName: selected.provider.code,
                    sourceVersion: selected.release.version,
                    sourceRecordId: row.sourceRecordId,
                    sourceNativeLevel: row.sourceNativeLevel,
                    clinicalDomain:
                      row.clinicalDomain as NormalizedSomaticEvidence["clinicalDomain"],
                    direction: row.direction,
                    diseaseMatch: "unknown",
                    summary: row.summary,
                    sourceUrl: row.sourceUrl,
                    rawResponseHash: row.rawResponseHash,
                    retrievedAt: selected.release.importedAt,
                    payload: row.payload,
                  },
                ]
              : []
          );
          return { records, unavailable: [] };
        },
      }
    : {
        knowledgeVersions: { CIViC: "offline_release_unavailable" },
        async collect() {
          return {
            records: [],
            unavailable: ["CIViC:offline_release_unavailable"],
          };
        },
      };

  const oncoKbConfig = oncoKbApiConfigFromEnv();
  const oncoKbRegistry = providerRows.find(
    row => row.code.trim().toLowerCase() === "oncokb"
  );
  const oncoKbGoverned =
    oncoKbConfig.mode !== "disabled" &&
    oncoKbRegistry?.enabled === true &&
    oncoKbRegistry.licenseStatus === "approved" &&
    Boolean(oncoKbRegistry.licenseReference) &&
    policyRows[0]?.enableOncoKb === true;
  const oncoKbProvider: SomaticEvidenceProvider = oncoKbGoverned
    ? createOncoKbApiProvider({ config: oncoKbConfig })
    : {
        knowledgeVersions: {
          OncoKB:
            oncoKbConfig.mode === "disabled"
              ? "disabled_pending_configuration"
              : "disabled_org_governance",
        },
        async collect() {
          return { records: [], unavailable: [] };
        },
      };

  return combineSomaticEvidenceProviders([civicProvider, oncoKbProvider]);
}

function combineSomaticEvidenceProviders(
  providers: SomaticEvidenceProvider[]
): SomaticEvidenceProvider {
  const knowledgeVersions: Record<string, string> = {};
  for (const provider of providers) {
    Object.assign(knowledgeVersions, provider.knowledgeVersions);
  }
  const collectBatch = async (
    variants: Parameters<SomaticEvidenceProvider["collect"]>[0][],
    tumor: SomaticTumorContext
  ) => {
    const output = new Map(
      variants.map(variant => [
        variant.normalizedId,
        { records: [], unavailable: [] } as {
          records: NormalizedSomaticEvidence[];
          unavailable: string[];
        },
      ])
    );
    for (const provider of providers) {
      const collected = provider.collectBatch
        ? await provider.collectBatch(variants, tumor)
        : new Map(
            await Promise.all(
              variants.map(
                async variant =>
                  [
                    variant.normalizedId,
                    await provider.collect(variant, tumor),
                  ] as const
              )
            )
          );
      Object.assign(knowledgeVersions, provider.knowledgeVersions);
      for (const variant of variants) {
        const target = output.get(variant.normalizedId)!;
        const source = collected.get(variant.normalizedId);
        if (source) {
          target.records.push(...source.records);
          target.unavailable.push(...source.unavailable);
        }
      }
    }
    return output;
  };
  return {
    knowledgeVersions,
    collectBatch,
    async collect(variant, tumor) {
      const result = await collectBatch([variant], tumor);
      return result.get(variant.normalizedId)!;
    },
  };
}

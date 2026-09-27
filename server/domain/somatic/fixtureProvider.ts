import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Variant } from "../../../drizzle/schema";
import type {
  NormalizedSomaticEvidence,
  SomaticEvidenceProvider,
} from "./provider";
import { preserveSourceNativePayload } from "./provider";

const DEFAULT_FIXTURE_ROOT = fileURLToPath(
  new URL("../../../shared/fixtures/somatic/v1/", import.meta.url)
);

const fixtureRecordSchema = z.object({
  variantId: z.string().min(1),
  sourceRecordId: z.string().min(1),
  sourceNativeLevel: z.string().nullable(),
  clinicalDomain: z.enum([
    "oncogenicity",
    "therapeutic",
    "diagnostic",
    "prognostic",
  ]),
  direction: z.enum(["supporting", "contradicting", "neutral"]),
  diseaseMatch: z.enum([
    "exact",
    "broader",
    "narrower",
    "none",
    "unknown",
    "manual",
  ]),
  summary: z.string().min(1),
  sourceUrl: z.string().url(),
  payload: z.record(z.string(), z.unknown()),
});

const civicPackSchema = z.object({
  schemaVersion: z.literal(1),
  sourceVersion: z.string().min(1),
  records: z.array(fixtureRecordSchema),
});

const fixtureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  packVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  civic: z.string().min(1),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      variantId: z.string().min(1),
      tumorLabel: z.string().min(1),
      providerOutage: z.boolean().optional(),
      reviewerGold: z.null(),
    })
  ),
});

type LoadedFixturePack = {
  packVersion: string;
  sourceVersion: string;
  retrievedAt: Date;
  outageVariantIds: Set<string>;
  recordsByVariant: Map<string, z.infer<typeof fixtureRecordSchema>[]>;
};

async function loadFixturePack(root: string): Promise<LoadedFixturePack> {
  const manifestPath = resolve(root, "manifest.json");
  const manifest = fixtureManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8"))
  );
  const civic = civicPackSchema.parse(
    JSON.parse(await readFile(resolve(root, manifest.civic), "utf8"))
  );
  const recordsByVariant = new Map<
    string,
    z.infer<typeof fixtureRecordSchema>[]
  >();
  for (const record of civic.records) {
    const records = recordsByVariant.get(record.variantId) ?? [];
    records.push(record);
    recordsByVariant.set(record.variantId, records);
  }

  return {
    packVersion: manifest.packVersion,
    sourceVersion: civic.sourceVersion,
    retrievedAt: new Date(manifest.generatedAt),
    outageVariantIds: new Set(
      manifest.cases
        .filter(item => item.providerOutage)
        .map(item => item.variantId)
    ),
    recordsByVariant,
  };
}

/**
 * Explicit deterministic provider for tests and scripts. Production routing
 * never selects this provider and there is deliberately no environment switch.
 */
export function createFixtureSomaticEvidenceProvider(options?: {
  fixtureRoot?: string;
}): SomaticEvidenceProvider {
  const packPromise = loadFixturePack(
    options?.fixtureRoot ?? DEFAULT_FIXTURE_ROOT
  );
  return {
    knowledgeVersions: {
      CIViC: "synthetic-civic-v1",
      fixturePack: "somatic-public-synthetic-v1",
      OncoKB: "disabled_pending_clinical_license",
    },
    async collect(variant: Variant, _tumorLabel: string) {
      const pack = await packPromise;
      if (pack.outageVariantIds.has(variant.normalizedId)) {
        return { records: [], unavailable: ["CIViC"] };
      }

      const records: NormalizedSomaticEvidence[] = (
        pack.recordsByVariant.get(variant.normalizedId) ?? []
      ).map(record => {
        const raw = JSON.stringify(record);
        return {
          sourceName: "CIViC",
          sourceVersion: pack.sourceVersion,
          sourceRecordId: record.sourceRecordId,
          sourceNativeLevel: record.sourceNativeLevel,
          clinicalDomain: record.clinicalDomain,
          direction: record.direction,
          diseaseMatch: record.diseaseMatch,
          summary: record.summary,
          sourceUrl: record.sourceUrl,
          rawResponseHash: createHash("sha256").update(raw).digest("hex"),
          retrievedAt: new Date(pack.retrievedAt),
          payload: {
            ...preserveSourceNativePayload(record.payload),
            fixturePack: pack.packVersion,
          },
        };
      });
      return { records, unavailable: [] };
    },
  };
}

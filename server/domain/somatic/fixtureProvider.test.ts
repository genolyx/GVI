import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Variant } from "../../../drizzle/schema";
import { createFixtureSomaticEvidenceProvider } from "./fixtureProvider";
import { preserveSourceNativePayload } from "./provider";

function variant(normalizedId: string): Variant {
  const now = new Date(0);
  const [, build, chromosome, position, reference, alternate] =
    normalizedId.match(/^(GRCh3[78]):([^:]+):(\d+):([^:]+):([^:]+)$/) ?? [];
  if (!build) throw new Error(`Invalid fixture variant ID: ${normalizedId}`);
  return {
    id: 1,
    organizationId: 1,
    caseId: 1,
    normalizedId,
    referenceBuild: build as Variant["referenceBuild"],
    chromosome,
    position: Number(position),
    referenceAllele: reference,
    alternateAllele: alternate,
    gene: null,
    transcript: null,
    hgvsC: null,
    hgvsP: null,
    consequence: null,
    variantType:
      reference.length === 1 && alternate.length === 1 ? "SNV" : "INDEL",
    zygosity: null,
    populationAf: null,
    vaf: "0.3",
    readDepth: 200,
    alternateDepth: 60,
    impact: "MODERATE",
    clinvarSignificance: null,
    reviewStatus: "unreviewed",
    annotation: { callFilter: "PASS" },
    triageTier: null,
    triageScore: null,
    triageReasons: null,
    triagedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("somatic fixture evidence provider", () => {
  it("returns stable EGFR sensitivity evidence", async () => {
    const provider = createFixtureSomaticEvidenceProvider();
    const input = variant("GRCh38:7:55259515:T:G");

    const first = await provider.collect(input, "NSCLC");
    const second = await provider.collect(input, "NSCLC");

    expect(first).toEqual(second);
    expect(first.unavailable).toEqual([]);
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({
      sourceName: "CIViC",
      sourceVersion: "synthetic-civic-v1",
      clinicalDomain: "therapeutic",
      direction: "supporting",
      diseaseMatch: "exact",
    });
    expect(first.records[0].retrievedAt.toISOString()).toBe(
      "2026-01-15T00:00:00.000Z"
    );
  });

  it("preserves source-native fields and hashes the untouched fixture record", async () => {
    const fixturePath = fileURLToPath(
      new URL("../../../shared/fixtures/somatic/v1/civic.json", import.meta.url)
    );
    const civic = JSON.parse(await readFile(fixturePath, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    const sourceRecord = civic.records[0];
    const collected = await createFixtureSomaticEvidenceProvider().collect(
      variant(sourceRecord.variantId as string),
      "Non-small cell lung cancer"
    );
    const normalized = collected.records[0];

    expect(normalized.sourceRecordId).toBe(sourceRecord.sourceRecordId);
    expect(normalized.sourceNativeLevel).toBe(sourceRecord.sourceNativeLevel);
    expect(normalized.summary).toBe(sourceRecord.summary);
    expect(normalized.rawResponseHash).toBe(
      createHash("sha256").update(JSON.stringify(sourceRecord)).digest("hex")
    );
    expect(normalized.payload).toMatchObject({
      ...(sourceRecord.payload as Record<string, unknown>),
      fixturePack: "somatic-public-synthetic-v1",
    });
  });

  it("never mixes source-native levels into AMP fields", async () => {
    const records = await createFixtureSomaticEvidenceProvider().collect(
      variant("GRCh38:3:179234297:A:G"),
      "Breast carcinoma"
    );

    expect(records.records.map(record => record.sourceNativeLevel)).toEqual([
      "B",
      "C",
    ]);
    for (const record of records.records) {
      expect(record).not.toHaveProperty("ampLevel");
      expect(record).not.toHaveProperty("ampTier");
      expect(record.payload).not.toHaveProperty("ampLevel");
      expect(record.payload).not.toHaveProperty("ampTier");
      expect(record.payload).not.toHaveProperty("systemLevel");
      expect(record.payload).not.toHaveProperty("systemTier");
    }

    expect(
      preserveSourceNativePayload({
        providerLevel: "B",
        ampLevel: "A",
        ampTier: "Tier I",
        systemLevel: "C",
        systemTier: "Tier II",
        finalLevel: "D",
        finalTier: "Tier III",
        sameTumor: true,
      })
    ).toEqual({ providerLevel: "B" });
  });

  it("represents conflict, no-evidence, and provider-outage cases", async () => {
    const provider = createFixtureSomaticEvidenceProvider();
    const conflict = await provider.collect(
      variant("GRCh38:3:179234297:A:G"),
      "Breast carcinoma"
    );
    expect(conflict.records.map(record => record.direction)).toEqual([
      "supporting",
      "contradicting",
    ]);

    const noEvidence = await provider.collect(
      variant("GRCh38:1:114716127:T:C"),
      "Melanoma"
    );
    expect(noEvidence).toEqual({ records: [], unavailable: [] });

    const outage = await provider.collect(
      variant("GRCh38:17:39723965:G:A"),
      "Breast carcinoma"
    );
    expect(outage).toEqual({ records: [], unavailable: ["CIViC"] });
  });

  it("keeps every synthetic case unreviewed", async () => {
    const path = fileURLToPath(
      new URL(
        "../../../shared/fixtures/somatic/v1/manifest.json",
        import.meta.url
      )
    );
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      cases: Array<{ reviewerGold: unknown }>;
    };

    expect(manifest.cases).toHaveLength(11);
    expect(manifest.cases.every(item => item.reviewerGold === null)).toBe(true);
  });
});

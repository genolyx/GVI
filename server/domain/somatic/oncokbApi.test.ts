import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Variant } from "../../../drizzle/schema";
import {
  createOncoKbApiProvider,
  getOncoKbApiMetrics,
  resetOncoKbApiStateForTests,
  resolveOncoKbAccess,
  type OncoKbApiConfig,
} from "./oncokbApi";

function variant(input?: Partial<Variant>): Variant {
  const now = new Date(0);
  return {
    id: 1,
    organizationId: 1,
    caseId: 1,
    normalizedId: "GRCh38:7:140753336:A:T",
    referenceBuild: "GRCh38",
    chromosome: "7",
    position: 140753336,
    referenceAllele: "A",
    alternateAllele: "T",
    gene: "BRAF",
    transcript: "NM_004333.6",
    hgvsC: "c.1799T>A",
    hgvsP: "p.Val600Glu",
    consequence: "missense_variant",
    variantType: "SNV",
    zygosity: null,
    populationAf: null,
    vaf: "0.32",
    readDepth: 500,
    alternateDepth: 160,
    impact: "HIGH",
    clinvarSignificance: null,
    reviewStatus: "unreviewed",
    annotation: { callFilter: "PASS" },
    triageTier: null,
    triageScore: null,
    triageReasons: null,
    triagedAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function config(
  mode: OncoKbApiConfig["mode"],
  overrides?: Partial<OncoKbApiConfig>
): OncoKbApiConfig {
  return {
    mode,
    token: mode === "demo" ? "" : "secret-token",
    baseUrl: "https://demo.oncokb.test",
    batchSize: 100,
    maxConcurrency: 3,
    requestTimeoutMs: 1000,
    retryCount: 0,
    cacheTtlMs: 60_000,
    ...overrides,
  };
}

function annotation(query: Record<string, unknown>) {
  return {
    query,
    geneExist: true,
    variantExist: true,
    alleleExist: true,
    oncogenic: "Oncogenic",
    mutationEffect: { knownEffect: "Gain-of-function" },
    highestSensitiveLevel: "LEVEL_1",
    highestResistanceLevel: "LEVEL_R1",
    treatments: [
      { level: "LEVEL_1", drugs: [{ drugName: "Dabrafenib" }] },
      { level: "LEVEL_R1", drugs: [{ drugName: "Cetuximab" }] },
    ],
    hotspot: true,
    dataVersion: "v2026.09",
    lastUpdate: "09/01/2026",
  };
}

describe("OncoKB API evidence provider", () => {
  beforeEach(() => resetOncoKbApiStateForTests());

  it("lets a school research token query without a commercial policy", () => {
    const research = config("research");
    const closed = {
      providerEnabled: false,
      licenseApproved: false,
      hasLicenseReference: false,
      policyEnabled: false,
    };
    expect(resolveOncoKbAccess(research, closed)).toBe("query");
    expect(
      resolveOncoKbAccess({ ...research, token: "" }, closed)
    ).toBe("token_missing");
    expect(resolveOncoKbAccess(config("demo"), closed)).toBe("query");
    expect(resolveOncoKbAccess(config("disabled"), closed)).toBe("disabled");
    expect(resolveOncoKbAccess(config("commercial"), closed)).toBe(
      "governance"
    );
    expect(
      resolveOncoKbAccess(config("commercial"), {
        providerEnabled: true,
        licenseApproved: true,
        hasLicenseReference: true,
        policyEnabled: true,
      })
    ).toBe("query");
  });

  it("uses batch POST, OncoTree context, source-native levels, and cache", async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const queries = JSON.parse(String(init?.body)) as Array<
        Record<string, unknown>
      >;
      return new Response(
        JSON.stringify(queries.map(query => annotation(query))),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("demo"),
      fetchImpl,
    });
    const input = variant();
    const tumor = {
      label: "Melanoma",
      ontologySystem: "OncoTree",
      ontologyVersion: "2026-09",
      code: "MEL",
    };

    const first = await provider.collectBatch!([input], tumor);
    const second = await provider.collectBatch!([input], tumor);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://demo.oncokb.test/api/v1/annotate/mutations/byProteinChange"
    );
    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body)
    ) as Array<Record<string, unknown>>;
    expect(request).toEqual([
      {
        referenceGenome: "GRCh38",
        gene: { hugoSymbol: "BRAF" },
        alteration: "V600E",
        tumorType: "MEL",
      },
    ]);
    const records = first.get(input.normalizedId)!.records;
    expect(records.map(record => record.clinicalDomain)).toContain(
      "oncogenicity"
    );
    expect(
      records.find(record => record.payload.association === "sensitivity")
    ).toMatchObject({
      sourceNativeLevel: "LEVEL_1",
      direction: "supporting",
      payload: { drugs: ["Dabrafenib"], researchOnly: true },
    });
    expect(
      records.find(record => record.payload.association === "resistance")
    ).toMatchObject({
      sourceNativeLevel: "LEVEL_R1",
      direction: "contradicting",
      payload: { researchOnly: true },
    });
    expect(records[0].payload).not.toHaveProperty("ampTier");
    expect(records[0].payload).not.toHaveProperty("ampLevel");
    expect(provider.knowledgeVersions.OncoKB).toBe("v2026.09");
    expect(second.get(input.normalizedId)!.records).toHaveLength(
      records.length
    );
    expect(getOncoKbApiMetrics()).toMatchObject({
      totalApiCalls: 1,
      batchCount: 1,
      variantsQueried: 1,
      cacheHits: 1,
      authErrors: 0,
    });
  });

  it("does not call research API before a token is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("research", { token: "" }),
      fetchImpl,
    });

    const result = await provider.collect(variant(), "Melanoma");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.unavailable).toEqual(["OncoKB:api_token_missing"]);
  });

  it("uses genomic batch fallback and never guesses tumorType from a label", async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const queries = JSON.parse(String(init?.body)) as Array<
        Record<string, unknown>
      >;
      return new Response(
        JSON.stringify(queries.map(query => annotation(query))),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("demo"),
      fetchImpl,
    });
    const input = variant({ gene: null, hgvsP: null });

    const result = await provider.collect(input, {
      label: "Free-text melanoma-like tumor",
      ontologySystem: "Internal",
      ontologyVersion: "1",
      code: "INT-1",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://demo.oncokb.test/api/v1/annotate/mutations/byGenomicChange"
    );
    const request = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body)
    ) as Array<Record<string, unknown>>;
    expect(request[0]).toMatchObject({
      referenceGenome: "GRCh38",
      genomicLocation: "7,140753336,140753336,A,T",
    });
    expect(request[0]).not.toHaveProperty("tumorType");
    expect(result.records[0].diseaseMatch).toBe("manual");
  });

  it("marks commercial API evidence as eligible for governed clinical review", async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const queries = JSON.parse(String(init?.body)) as Array<
        Record<string, unknown>
      >;
      return new Response(
        JSON.stringify(queries.map(query => annotation(query))),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("commercial"),
      fetchImpl,
    });

    const result = await provider.collect(variant(), "Melanoma");

    expect(result.records.length).toBeGreaterThan(0);
    expect(
      result.records.every(record => record.payload.researchOnly === false)
    ).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("detects authentication errors without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("forbidden", { status: 403 })
    ) as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("research", { retryCount: 3 }),
      fetchImpl,
    });

    const result = await provider.collect(variant(), "Melanoma");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.unavailable).toEqual(["OncoKB:auth_error"]);
    expect(getOncoKbApiMetrics().authErrors).toBe(1);
  });

  it("retries 429 responses using Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      )
      .mockImplementationOnce(async (_input: unknown, init?: RequestInit) => {
        const queries = JSON.parse(String(init?.body)) as Array<
          Record<string, unknown>
        >;
        return new Response(
          JSON.stringify(queries.map(query => annotation(query))),
          { status: 200 }
        );
      }) as unknown as typeof fetch;
    const provider = createOncoKbApiProvider({
      config: config("research", { retryCount: 1 }),
      fetchImpl,
    });

    const result = await provider.collect(variant(), "Melanoma");

    expect(result.records.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getOncoKbApiMetrics()).toMatchObject({
      retries: 1,
      rateLimitErrors: 1,
    });
  });
});

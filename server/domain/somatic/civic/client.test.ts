import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CivicClientError,
  createCivicGraphQlClient,
  getCivicClientMetrics,
  resetCivicClientStateForTests,
} from "./client";
import { paginateCivic } from "./pagination";

describe("CIViC GraphQL transport and pagination", () => {
  beforeEach(() => resetCivicClientStateForTests());

  it("hashes the exact body, excludes the bearer secret, and caches", async () => {
    const rawBody = '{ "data": { "gene": null } }\n';
    const fetchImpl = vi.fn(
      async () =>
        new Response(rawBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "secret-cookie",
          },
        })
    ) as unknown as typeof fetch;
    const client = createCivicGraphQlClient(
      {
        bearerToken: "top-secret",
        cacheTtlMs: 1_000,
        minimumRequestIntervalMs: 0,
      },
      { fetch: fetchImpl, now: () => 0 }
    );

    const first = await client.execute<{ gene: null }>("ResolveGene", {
      symbol: "BRAF",
    });
    const second = await client.execute<{ gene: null }>("ResolveGene", {
      symbol: "BRAF",
    });

    expect(first.rawBody).toBe(rawBody);
    expect(first.envelope.bodySha256).toBe(
      createHash("sha256").update(rawBody).digest("hex")
    );
    expect(JSON.stringify(first.envelope)).not.toContain("top-secret");
    expect(first.envelope.safeResponseHeaders).not.toHaveProperty("set-cookie");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://civicdb.org/api/graphql"
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer top-secret",
    });
    expect(second.envelope.cacheHit).toBe(true);
    expect(getCivicClientMetrics().cacheHits).toBe(1);
  });

  it("retries 429 with Retry-After but never retries auth or GraphQL errors", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "2" },
        })
      )
      .mockResolvedValueOnce(
        new Response('{"data":{"gene":null}}', { status: 200 })
      ) as unknown as typeof fetch;
    const retryClient = createCivicGraphQlClient(
      { retryCount: 2, minimumRequestIntervalMs: 0, cacheTtlMs: 0 },
      {
        fetch: retryFetch,
        now: () => now,
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      }
    );
    await retryClient.execute("ResolveGene", { symbol: "BRAF" });
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);

    resetCivicClientStateForTests();
    const authFetch = vi.fn(
      async () => new Response("forbidden", { status: 403 })
    ) as unknown as typeof fetch;
    const authClient = createCivicGraphQlClient(
      { retryCount: 3, minimumRequestIntervalMs: 0 },
      { fetch: authFetch }
    );
    await expect(
      authClient.execute("ResolveGene", { symbol: "BRAF" })
    ).rejects.toMatchObject({ code: "AUTH", retryable: false });
    expect(authFetch).toHaveBeenCalledTimes(1);

    resetCivicClientStateForTests();
    const validationFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                message: "Cannot query field bad",
                extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
              },
            ],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const validationClient = createCivicGraphQlClient(
      { retryCount: 3, minimumRequestIntervalMs: 0 },
      { fetch: validationFetch }
    );
    await expect(
      validationClient.execute("CheckEvidenceContract", {})
    ).rejects.toMatchObject({
      code: "GRAPHQL_VALIDATION",
      retryable: false,
    });
    expect(validationFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies injected timeout and bounds retries", async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => undefined)
    ) as unknown as typeof fetch;
    const client = createCivicGraphQlClient(
      { retryCount: 0, timeoutMs: 5, minimumRequestIntervalMs: 0 },
      {
        fetch: fetchImpl,
        setTimer: callback => {
          queueMicrotask(callback);
          return 1;
        },
        clearTimer: () => undefined,
      }
    );
    await expect(
      client.execute("ResolveGene", { symbol: "BRAF" })
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collects three pages once and stops on a stuck cursor", async () => {
    const pages = [
      {
        nodes: [{ id: 1 }, { id: 2 }],
        pageInfo: { hasNextPage: true, endCursor: "a" },
      },
      {
        nodes: [{ id: 2 }, { id: 3 }],
        pageInfo: { hasNextPage: true, endCursor: "b" },
      },
      { nodes: [{ id: 4 }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const client = {
      execute: vi.fn(async () => ({
        data: { evidenceItems: pages.shift()! },
        rawBody: "{}",
        envelope: { requestId: "request" },
      })),
    } as unknown as ReturnType<typeof createCivicGraphQlClient>;
    const result = await paginateCivic<
      {
        evidenceItems: {
          nodes: Array<{ id: number }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      },
      { id: number }
    >({
      client,
      operationName: "AcceptedEvidence",
      variables: { mpId: 1, first: 25 },
      connection: data => data.evidenceItems,
      dedupeKey: node => node.id,
    });
    expect(result.state).toBe("COMPLETE");
    expect(result.items.map(item => item.id)).toEqual([1, 2, 3, 4]);
    expect(result.completeness.pages).toBe(3);

    const stuckClient = {
      execute: vi.fn(async () => ({
        data: {
          evidenceItems: {
            nodes: [{ id: 1 }],
            pageInfo: { hasNextPage: true, endCursor: "same" },
          },
        },
        rawBody: "{}",
        envelope: { requestId: "request" },
      })),
    } as unknown as ReturnType<typeof createCivicGraphQlClient>;
    const stuck = await paginateCivic<
      {
        evidenceItems: {
          nodes: Array<{ id: number }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      },
      { id: number }
    >({
      client: stuckClient,
      operationName: "AcceptedEvidence",
      variables: { mpId: 1, first: 25 },
      connection: data => data.evidenceItems,
      dedupeKey: node => node.id,
    });
    expect(stuck.state).toBe("PARTIAL");
    expect(stuck.completeness.reason).toBe("CURSOR_NOT_ADVANCING");
    expect(stuckClient.execute).toHaveBeenCalledTimes(2);
  });

  it("returns partial records when a later page fails", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          evidenceItems: {
            nodes: [{ id: 1 }],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
        rawBody: "{}",
        envelope: { requestId: "ok" },
      })
      .mockRejectedValueOnce(
        new CivicClientError("network", "NETWORK", true, "failed", {} as never)
      );
    const result = await paginateCivic<
      {
        evidenceItems: {
          nodes: Array<{ id: number }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      },
      { id: number }
    >({
      client: { execute } as unknown as ReturnType<
        typeof createCivicGraphQlClient
      >,
      operationName: "AcceptedEvidence",
      variables: { mpId: 1, first: 25 },
      connection: data => data.evidenceItems,
      dedupeKey: node => node.id,
    });
    expect(result).toMatchObject({
      state: "PARTIAL",
      items: [{ id: 1 }],
      completeness: { complete: false, pages: 1, reason: "NETWORK" },
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { CIVIC_OPERATIONS, type CivicOperationName } from "./queries";
import type {
  CivicErrorCode,
  GraphQlEnvelope,
  RawResponseEnvelope,
} from "./types";

export const CIVIC_GRAPHQL_ENDPOINT = "https://civicdb.org/api/graphql";

export type CivicClientConfig = {
  bearerToken?: string;
  timeoutMs?: number;
  retryCount?: number;
  cacheTtlMs?: number;
  minimumRequestIntervalMs?: number;
};

export type CivicClientDependencies = {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  random: () => number;
  setTimer: (callback: () => void, milliseconds: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

export type CivicClientMetrics = {
  requests: number;
  retries: number;
  cacheHits: number;
  rateLimited: number;
  authErrors: number;
  graphqlErrors: number;
  networkErrors: number;
  timeouts: number;
  responseTimeMs: number;
  statusCounts: Record<string, number>;
};

export class CivicClientError extends Error {
  constructor(
    message: string,
    readonly code: CivicErrorCode,
    readonly retryable: boolean,
    readonly requestId: string,
    readonly envelope: RawResponseEnvelope
  ) {
    super(message);
    this.name = "CivicClientError";
  }
}

export type CivicGraphQlResult<T> = {
  data: T;
  rawBody: string;
  envelope: RawResponseEnvelope;
};

type CacheEntry = {
  expiresAt: number;
  original: CivicGraphQlResult<unknown>;
};

const responseCache = new Map<string, CacheEntry>();
const metrics: CivicClientMetrics = {
  requests: 0,
  retries: 0,
  cacheHits: 0,
  rateLimited: 0,
  authErrors: 0,
  graphqlErrors: 0,
  networkErrors: 0,
  timeouts: 0,
  responseTimeMs: 0,
  statusCounts: {},
};
let nextRequestAt = 0;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function safeHeaders(headers: Headers): Record<string, string> {
  const allowed = ["content-type", "retry-after", "x-request-id"];
  return Object.fromEntries(
    allowed.flatMap(name => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
}

function validationError(errors: GraphQlEnvelope<unknown>["errors"]): boolean {
  return Boolean(
    errors?.some(error => {
      const code = error.extensions?.code;
      return (
        code === "GRAPHQL_VALIDATION_FAILED" ||
        /cannot query field|unknown (argument|type)|validation/i.test(
          error.message
        )
      );
    })
  );
}

export function getCivicClientMetrics(): Readonly<CivicClientMetrics> {
  return { ...metrics, statusCounts: { ...metrics.statusCounts } };
}

export function resetCivicClientStateForTests(): void {
  responseCache.clear();
  nextRequestAt = 0;
  Object.assign(metrics, {
    requests: 0,
    retries: 0,
    cacheHits: 0,
    rateLimited: 0,
    authErrors: 0,
    graphqlErrors: 0,
    networkErrors: 0,
    timeouts: 0,
    responseTimeMs: 0,
    statusCounts: {},
  });
}

export function createCivicGraphQlClient(
  config: CivicClientConfig = {},
  dependencies: Partial<CivicClientDependencies> = {}
) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const setTimer =
    dependencies.setTimer ??
    ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer =
    dependencies.clearTimer ??
    (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const timeoutMs = Math.max(1, config.timeoutMs ?? 5_000);
  const retryCount = Math.min(3, Math.max(0, config.retryCount ?? 3));
  const cacheTtlMs = Math.max(0, config.cacheTtlMs ?? 6 * 60 * 60 * 1000);
  const minimumInterval = Math.max(0, config.minimumRequestIntervalMs ?? 1_000);

  async function acquireRateLimit(): Promise<void> {
    const wait = Math.max(0, nextRequestAt - now());
    if (wait) await sleep(wait);
    nextRequestAt = Math.max(nextRequestAt, now()) + minimumInterval;
  }

  async function execute<T>(
    operationName: CivicOperationName,
    variables: Record<string, unknown>
  ): Promise<CivicGraphQlResult<T>> {
    const query = CIVIC_OPERATIONS[operationName];
    const querySha256 = sha256(query);
    const cacheKey = sha256(
      `${operationName}\0${querySha256}\0${canonical(variables)}`
    );
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      metrics.cacheHits += 1;
      const original = cached.original as CivicGraphQlResult<T>;
      return {
        ...original,
        envelope: { ...original.envelope, cacheHit: true },
      };
    }
    responseCache.delete(cacheKey);

    let lastError: CivicClientError | null = null;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      await acquireRateLimit();
      const requestId = randomUUID();
      const startedAt = now();
      const requestedAtUTC = new Date(startedAt).toISOString();
      const controller = new AbortController();
      let timedOut = false;
      let timeoutHandle: unknown;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimer(() => {
          timedOut = true;
          controller.abort();
          reject(new DOMException("CIViC request timed out.", "AbortError"));
        }, timeoutMs);
      });
      let response: Response | null = null;
      let body = "";
      try {
        metrics.requests += 1;
        const request = fetchImpl(CIVIC_GRAPHQL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.bearerToken
              ? { Authorization: `Bearer ${config.bearerToken}` }
              : {}),
          },
          body: JSON.stringify({ operationName, query, variables }),
          signal: controller.signal,
        });
        response = await Promise.race([request, timeout]);
        body = await response.text();
        const endedAt = now();
        metrics.responseTimeMs += Math.max(0, endedAt - startedAt);
        metrics.statusCounts[String(response.status)] =
          (metrics.statusCounts[String(response.status)] ?? 0) + 1;
        const envelope: RawResponseEnvelope = {
          requestId,
          provider: "CIVIC",
          endpoint: CIVIC_GRAPHQL_ENDPOINT,
          operationName,
          querySha256,
          requestedAtUTC,
          receivedAtUTC: new Date(endedAt).toISOString(),
          durationMs: Math.max(0, endedAt - startedAt),
          httpStatus: response.status,
          contentType: response.headers.get("content-type"),
          safeResponseHeaders: safeHeaders(response.headers),
          responseByteLength: Buffer.byteLength(body),
          bodySha256: sha256(body),
          graphqlErrors: [],
          cacheHit: false,
        };
        if (response.status === 401 || response.status === 403) {
          metrics.authErrors += 1;
          throw new CivicClientError(
            `CIViC authentication failed (${response.status}).`,
            "AUTH",
            false,
            requestId,
            envelope
          );
        }
        if (response.status === 429 || response.status >= 500) {
          if (response.status === 429) metrics.rateLimited += 1;
          throw new CivicClientError(
            `CIViC transient HTTP error (${response.status}).`,
            response.status === 429 ? "RATE_LIMIT" : "SERVER",
            true,
            requestId,
            envelope
          );
        }
        if (!response.ok) {
          throw new CivicClientError(
            `CIViC rejected the request (${response.status}).`,
            "PROTOCOL",
            false,
            requestId,
            envelope
          );
        }
        let decoded: GraphQlEnvelope<T>;
        try {
          decoded = JSON.parse(body) as GraphQlEnvelope<T>;
        } catch {
          throw new CivicClientError(
            "CIViC returned invalid JSON.",
            "PROTOCOL",
            false,
            requestId,
            envelope
          );
        }
        envelope.graphqlErrors = decoded.errors ?? [];
        if (decoded.errors?.length) {
          metrics.graphqlErrors += 1;
          throw new CivicClientError(
            "CIViC returned GraphQL errors.",
            validationError(decoded.errors)
              ? "GRAPHQL_VALIDATION"
              : "GRAPHQL_ERROR",
            false,
            requestId,
            envelope
          );
        }
        if (decoded.data === undefined || decoded.data === null) {
          throw new CivicClientError(
            "CIViC response did not contain data.",
            "PROTOCOL",
            false,
            requestId,
            envelope
          );
        }
        const result: CivicGraphQlResult<T> = {
          data: decoded.data,
          rawBody: body,
          envelope,
        };
        if (cacheTtlMs > 0) {
          responseCache.set(cacheKey, {
            expiresAt: now() + cacheTtlMs,
            original: result as CivicGraphQlResult<unknown>,
          });
        }
        return result;
      } catch (error) {
        const endedAt = now();
        const emptyEnvelope: RawResponseEnvelope = {
          requestId,
          provider: "CIVIC",
          endpoint: CIVIC_GRAPHQL_ENDPOINT,
          operationName,
          querySha256,
          requestedAtUTC,
          receivedAtUTC: new Date(endedAt).toISOString(),
          durationMs: Math.max(0, endedAt - startedAt),
          httpStatus: response?.status ?? null,
          contentType: response?.headers.get("content-type") ?? null,
          safeResponseHeaders: response ? safeHeaders(response.headers) : {},
          responseByteLength: Buffer.byteLength(body),
          bodySha256: body ? sha256(body) : null,
          graphqlErrors: [],
          cacheHit: false,
        };
        const normalized =
          error instanceof CivicClientError
            ? error
            : timedOut ||
                (error instanceof Error && error.name === "AbortError")
              ? new CivicClientError(
                  "CIViC request timed out.",
                  "TIMEOUT",
                  true,
                  requestId,
                  emptyEnvelope
                )
              : new CivicClientError(
                  "CIViC network request failed.",
                  "NETWORK",
                  true,
                  requestId,
                  emptyEnvelope
                );
        if (normalized.code === "TIMEOUT") metrics.timeouts += 1;
        if (normalized.code === "NETWORK") metrics.networkErrors += 1;
        lastError = normalized;
        if (!normalized.retryable || attempt >= retryCount) throw normalized;
        metrics.retries += 1;
        const fromHeader = retryAfterMs(
          response?.headers.get("retry-after") ?? null,
          now()
        );
        const backoff =
          fromHeader ?? Math.floor(2 ** attempt * 1_000 * random());
        await sleep(backoff);
      } finally {
        clearTimer(timeoutHandle);
      }
    }
    throw lastError ?? new Error("CIViC request failed.");
  }

  return { execute };
}

export type CivicGraphQlClient = ReturnType<typeof createCivicGraphQlClient>;

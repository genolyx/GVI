import { createHash } from "node:crypto";
import type { Variant } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import { proteinChangeFromHgvs } from "../proteinChange";
import {
  preserveSourceNativePayload,
  type NormalizedSomaticEvidence,
  type SomaticEvidenceCollection,
  type SomaticEvidenceProvider,
  type SomaticTumorContext,
} from "./provider";

export type OncoKbApiMode = "disabled" | "demo" | "research" | "commercial";

export type OncoKbApiConfig = {
  mode: OncoKbApiMode;
  token: string;
  baseUrl: string;
  batchSize: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  retryCount: number;
  cacheTtlMs: number;
};

export type OncoKbApiMetrics = {
  totalApiCalls: number;
  batchCount: number;
  variantsQueried: number;
  cacheHits: number;
  retries: number;
  authErrors: number;
  rateLimitErrors: number;
  serverErrors: number;
  timeouts: number;
  totalResponseTimeMs: number;
  httpStatusCounts: Record<string, number>;
};

type OncoKbQuery = {
  referenceGenome: "GRCh37" | "GRCh38";
  gene?: { hugoSymbol: string };
  alteration?: string;
  genomicLocation?: string;
  tumorType?: string;
};

type OncoKbTreatment = {
  level?: string;
  drugs?: Array<{ drugName?: string }>;
  levelAssociatedCancerType?: {
    code?: string;
    name?: string;
    mainType?: string;
  };
};

export type OncoKbAnnotation = {
  query?: OncoKbQuery;
  geneExist?: boolean;
  variantExist?: boolean;
  alleleExist?: boolean;
  oncogenic?: string;
  mutationEffect?: {
    knownEffect?: string;
    description?: string;
    citations?: unknown[];
  };
  highestSensitiveLevel?: string | null;
  highestResistanceLevel?: string | null;
  highestDiagnosticImplicationLevel?: string | null;
  highestPrognosticImplicationLevel?: string | null;
  otherSignificantSensitiveLevels?: string[];
  otherSignificantResistanceLevels?: string[];
  treatments?: OncoKbTreatment[];
  hotspot?: boolean;
  geneSummary?: string;
  variantSummary?: string;
  tumorTypeSummary?: string;
  diagnosticSummary?: string;
  prognosticSummary?: string;
  diagnosticImplications?: unknown[];
  prognosticImplications?: unknown[];
  dataVersion?: string;
  lastUpdate?: string;
  [key: string]: unknown;
};

type PreparedQuery = {
  variant: Variant;
  endpoint: "byProteinChange" | "byGenomicChange";
  query: OncoKbQuery;
  cacheKey: string;
};

type CachedAnnotation = {
  expiresAt: number;
  annotation: OncoKbAnnotation;
};

class OncoKbRequestError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth"
      | "rate_limit"
      | "server"
      | "timeout"
      | "network"
      | "response"
  ) {
    super(message);
  }
}

const responseCache = new Map<string, CachedAnnotation>();
const metrics: OncoKbApiMetrics = {
  totalApiCalls: 0,
  batchCount: 0,
  variantsQueried: 0,
  cacheHits: 0,
  retries: 0,
  authErrors: 0,
  rateLimitErrors: 0,
  serverErrors: 0,
  timeouts: 0,
  totalResponseTimeMs: 0,
  httpStatusCounts: {},
};

export function oncoKbApiConfigFromEnv(): OncoKbApiConfig {
  return {
    mode: ENV.oncokbMode,
    token: ENV.oncokbApiToken,
    baseUrl: ENV.oncokbBaseUrl,
    batchSize: Math.min(500, Math.max(1, ENV.oncokbBatchSize)),
    maxConcurrency: Math.min(10, Math.max(1, ENV.oncokbMaxConcurrency)),
    requestTimeoutMs: ENV.oncokbRequestTimeoutSeconds * 1000,
    retryCount: Math.min(5, Math.max(0, ENV.oncokbRetryCount)),
    cacheTtlMs: ENV.oncokbCacheTtlSeconds * 1000,
  };
}

export function getOncoKbApiMetrics(): Readonly<OncoKbApiMetrics> {
  return {
    ...metrics,
    httpStatusCounts: { ...metrics.httpStatusCounts },
  };
}

export function resetOncoKbApiStateForTests() {
  responseCache.clear();
  Object.assign(metrics, {
    totalApiCalls: 0,
    batchCount: 0,
    variantsQueried: 0,
    cacheHits: 0,
    retries: 0,
    authErrors: 0,
    rateLimitErrors: 0,
    serverErrors: 0,
    timeouts: 0,
    totalResponseTimeMs: 0,
    httpStatusCounts: {},
  });
}

function tumorDetails(tumor: SomaticTumorContext) {
  if (typeof tumor === "string") {
    return {
      label: tumor,
      ontologySystem: null,
      ontologyVersion: null,
      code: null,
      oncoTreeCode: null,
    };
  }
  const isOncoTree = tumor.ontologySystem.trim().toLowerCase() === "oncotree";
  return {
    ...tumor,
    oncoTreeCode: isOncoTree ? tumor.code : null,
  };
}

function prepareQuery(
  variant: Variant,
  tumor: SomaticTumorContext,
  config: OncoKbApiConfig
): PreparedQuery | null {
  const referenceGenome =
    variant.referenceBuild === "GRCh37" ? "GRCh37" : "GRCh38";
  const oncoTreeCode = tumorDetails(tumor).oncoTreeCode;
  const alteration = proteinChangeFromHgvs(variant.hgvsP);
  let endpoint: PreparedQuery["endpoint"];
  let query: OncoKbQuery;
  if (variant.gene && alteration) {
    endpoint = "byProteinChange";
    query = {
      referenceGenome,
      gene: { hugoSymbol: variant.gene },
      alteration,
      ...(oncoTreeCode ? { tumorType: oncoTreeCode } : {}),
    };
  } else if (
    variant.chromosome &&
    variant.position &&
    variant.referenceAllele &&
    variant.alternateAllele
  ) {
    endpoint = "byGenomicChange";
    query = {
      referenceGenome,
      genomicLocation: [
        variant.chromosome.replace(/^chr/i, ""),
        variant.position,
        variant.position + Math.max(variant.referenceAllele.length - 1, 0),
        variant.referenceAllele,
        variant.alternateAllele,
      ].join(","),
      ...(oncoTreeCode ? { tumorType: oncoTreeCode } : {}),
    };
  } else {
    return null;
  }
  return {
    variant,
    endpoint,
    query,
    cacheKey: createHash("sha256")
      .update(
        JSON.stringify({
          baseUrl: config.baseUrl,
          mode: config.mode,
          endpoint,
          query,
        })
      )
      .digest("hex"),
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return 2 ** (attempt + 1) * 1000 + Math.floor(Math.random() * 250);
}

async function requestBatch(
  endpoint: PreparedQuery["endpoint"],
  batch: PreparedQuery[],
  config: OncoKbApiConfig,
  fetchImpl: typeof fetch
): Promise<OncoKbAnnotation[]> {
  const url = `${config.baseUrl}/api/v1/annotate/mutations/${endpoint}`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.requestTimeoutMs
    );
    const startedAt = Date.now();
    let response: Response | null = null;
    try {
      metrics.totalApiCalls += 1;
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify(batch.map(item => item.query)),
        signal: controller.signal,
      });
      metrics.totalResponseTimeMs += Date.now() - startedAt;
      const statusKey = String(response.status);
      metrics.httpStatusCounts[statusKey] =
        (metrics.httpStatusCounts[statusKey] ?? 0) + 1;
      if (response.status === 401 || response.status === 403) {
        metrics.authErrors += 1;
        throw new OncoKbRequestError(
          `OncoKB authentication failed (${response.status}).`,
          "auth"
        );
      }
      if (response.status === 429) {
        metrics.rateLimitErrors += 1;
        throw new OncoKbRequestError(
          "OncoKB rate limit exceeded.",
          "rate_limit"
        );
      }
      if (response.status >= 500) {
        metrics.serverErrors += 1;
        throw new OncoKbRequestError(
          `OncoKB server error (${response.status}).`,
          "server"
        );
      }
      if (!response.ok) {
        throw new OncoKbRequestError(
          `OncoKB request rejected (${response.status}).`,
          "response"
        );
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body) || body.length !== batch.length) {
        throw new OncoKbRequestError(
          "OncoKB batch response shape or length is invalid.",
          "response"
        );
      }
      return body as OncoKbAnnotation[];
    } catch (error) {
      const requestError =
        error instanceof OncoKbRequestError
          ? error
          : error instanceof Error && error.name === "AbortError"
            ? new OncoKbRequestError("OncoKB request timed out.", "timeout")
            : new OncoKbRequestError(
                error instanceof Error
                  ? error.message
                  : "OncoKB network error.",
                "network"
              );
      if (requestError.kind === "timeout") metrics.timeouts += 1;
      lastError = requestError;
      const retryable = ["rate_limit", "server", "timeout", "network"].includes(
        requestError.kind
      );
      if (!retryable || attempt >= config.retryCount) throw requestError;
      metrics.retries += 1;
      await sleep(retryDelayMs(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("OncoKB request failed.");
}

async function annotatePreparedQueries(
  prepared: PreparedQuery[],
  config: OncoKbApiConfig,
  fetchImpl: typeof fetch
): Promise<
  Map<string, { query: PreparedQuery; annotation: OncoKbAnnotation }>
> {
  const now = Date.now();
  const output = new Map<
    string,
    { query: PreparedQuery; annotation: OncoKbAnnotation }
  >();
  const misses: PreparedQuery[] = [];
  for (const item of prepared) {
    const cached = responseCache.get(item.cacheKey);
    if (cached && cached.expiresAt > now) {
      metrics.cacheHits += 1;
      output.set(item.variant.normalizedId, {
        query: item,
        annotation: cached.annotation,
      });
    } else {
      responseCache.delete(item.cacheKey);
      misses.push(item);
    }
  }
  const jobs = (["byProteinChange", "byGenomicChange"] as const).flatMap(
    endpoint =>
      chunks(
        misses.filter(item => item.endpoint === endpoint),
        config.batchSize
      ).map(batch => ({ endpoint, batch }))
  );
  for (let offset = 0; offset < jobs.length; offset += config.maxConcurrency) {
    const group = jobs.slice(offset, offset + config.maxConcurrency);
    const responses = await Promise.all(
      group.map(async job => ({
        job,
        annotations: await requestBatch(
          job.endpoint,
          job.batch,
          config,
          fetchImpl
        ),
      }))
    );
    for (const { job, annotations } of responses) {
      metrics.batchCount += 1;
      metrics.variantsQueried += job.batch.length;
      annotations.forEach((annotation, index) => {
        const item = job.batch[index];
        responseCache.set(item.cacheKey, {
          expiresAt: Date.now() + config.cacheTtlMs,
          annotation,
        });
        output.set(item.variant.normalizedId, {
          query: item,
          annotation,
        });
      });
    }
  }
  return output;
}

function treatmentNames(
  treatments: OncoKbTreatment[] | undefined,
  level: string
): string[] {
  return Array.from(
    new Set(
      (treatments ?? [])
        .filter(treatment => treatment.level === level)
        .flatMap(treatment =>
          (treatment.drugs ?? []).flatMap(drug =>
            drug.drugName ? [drug.drugName] : []
          )
        )
    )
  ).sort();
}

function evidenceRecords(
  prepared: PreparedQuery,
  annotation: OncoKbAnnotation,
  tumor: SomaticTumorContext,
  config: OncoKbApiConfig
): NormalizedSomaticEvidence[] {
  const retrievedAt = new Date();
  const dataVersion = annotation.dataVersion || "api_unversioned";
  const sourceVersion = dataVersion.slice(0, 80);
  const rawResponseHash = createHash("sha256")
    .update(JSON.stringify(annotation))
    .digest("hex");
  const sourceKey = `ONCOKB:${createHash("sha256")
    .update(JSON.stringify(prepared.query))
    .digest("hex")
    .slice(0, 24)}`;
  const details = tumorDetails(tumor);
  const researchOnly = config.mode !== "commercial";
  const sourceUrl = `${config.baseUrl}/gene/${encodeURIComponent(
    prepared.variant.gene || prepared.query.gene?.hugoSymbol || "unknown"
  )}/${encodeURIComponent(
    prepared.query.alteration || prepared.query.genomicLocation || "unknown"
  )}`;
  const commonPayload = {
    provider: "OncoKB",
    endpoint: `/api/v1/annotate/mutations/${prepared.endpoint}`,
    normalizedQuery: prepared.query,
    requestPayload: prepared.query,
    dataVersion,
    lastUpdate: annotation.lastUpdate ?? null,
    retrievedAt: retrievedAt.toISOString(),
    licenseMode: config.mode,
    researchOnly,
    oncoTreeMapping: details.oncoTreeCode
      ? {
          status: "exact",
          code: details.oncoTreeCode,
          version: details.ontologyVersion,
        }
      : {
          status: "manual_review_required",
          internalSystem: details.ontologySystem,
          internalCode: details.code,
        },
    ...(details.oncoTreeCode
      ? {
          diseaseOntology: {
            ontologySystem: "OncoTree",
            ontologyVersion: details.ontologyVersion,
            code: details.oncoTreeCode,
            label: details.label,
          },
        }
      : {}),
    sourceResponse: preserveSourceNativePayload(annotation),
  };
  const base = {
    sourceName: "OncoKB",
    sourceVersion,
    diseaseMatch: details.oncoTreeCode
      ? ("exact" as const)
      : ("manual" as const),
    sourceUrl,
    rawResponseHash,
    retrievedAt,
  };
  const records: NormalizedSomaticEvidence[] = [];
  if (annotation.oncogenic || annotation.mutationEffect || annotation.hotspot) {
    records.push({
      ...base,
      sourceRecordId: `${sourceKey}:oncogenicity`,
      sourceNativeLevel: annotation.oncogenic?.slice(0, 80) ?? null,
      clinicalDomain: "oncogenicity",
      direction: "neutral",
      summary:
        annotation.variantSummary ||
        `OncoKB oncogenicity: ${annotation.oncogenic || "not stated"}; mutation effect: ${annotation.mutationEffect?.knownEffect || "not stated"}.`,
      payload: {
        ...commonPayload,
        oncogenicity: annotation.oncogenic ?? null,
        mutationEffect: annotation.mutationEffect ?? null,
        hotspot: annotation.hotspot === true,
        geneExist: annotation.geneExist ?? null,
        variantExist: annotation.variantExist ?? null,
        alleleExist: annotation.alleleExist ?? null,
      },
    });
  }
  const levelRows = [
    {
      levels: [
        annotation.highestSensitiveLevel,
        ...(annotation.otherSignificantSensitiveLevels ?? []),
      ],
      domain: "therapeutic" as const,
      association: "sensitivity",
      direction: "supporting" as const,
      summary: annotation.tumorTypeSummary,
    },
    {
      levels: [
        annotation.highestResistanceLevel,
        ...(annotation.otherSignificantResistanceLevels ?? []),
      ],
      domain: "therapeutic" as const,
      association: "resistance",
      direction: "contradicting" as const,
      summary: annotation.tumorTypeSummary,
    },
    {
      levels: [annotation.highestDiagnosticImplicationLevel],
      domain: "diagnostic" as const,
      association: "diagnostic",
      direction: "supporting" as const,
      summary: annotation.diagnosticSummary,
    },
    {
      levels: [annotation.highestPrognosticImplicationLevel],
      domain: "prognostic" as const,
      association: "prognostic",
      direction: "supporting" as const,
      summary: annotation.prognosticSummary,
    },
  ];
  for (const row of levelRows) {
    for (const level of Array.from(
      new Set(row.levels.filter((value): value is string => Boolean(value)))
    )) {
      const drugs = treatmentNames(annotation.treatments, level);
      records.push({
        ...base,
        sourceRecordId: `${sourceKey}:${row.association}:${level}`,
        sourceNativeLevel: level.slice(0, 80),
        clinicalDomain: row.domain,
        direction: row.direction,
        summary:
          row.summary ||
          `OncoKB ${row.association} evidence level ${level}${
            drugs.length ? `; therapies: ${drugs.join(", ")}` : ""
          }.`,
        payload: {
          ...commonPayload,
          association: row.association,
          oncoKbLevel: level,
          drugs,
          treatments: annotation.treatments ?? [],
        },
      });
    }
  }
  return records;
}

function unavailableReason(error: unknown): string {
  if (error instanceof OncoKbRequestError) {
    if (error.kind === "auth") return "OncoKB:auth_error";
    if (error.kind === "rate_limit") return "OncoKB:rate_limited";
    if (error.kind === "timeout") return "OncoKB:timeout";
    return `OncoKB:${error.kind}_error`;
  }
  return "OncoKB:api_error";
}

export function createOncoKbApiProvider(options?: {
  config?: OncoKbApiConfig;
  fetchImpl?: typeof fetch;
}): SomaticEvidenceProvider {
  const config = options?.config ?? oncoKbApiConfigFromEnv();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const versions: Record<string, string> = {
    OncoKB:
      config.mode === "disabled"
        ? "disabled"
        : config.mode === "demo"
          ? "demo"
          : `${config.mode}_api`,
  };

  async function collectBatch(
    variants: Variant[],
    tumor: SomaticTumorContext
  ): Promise<Map<string, SomaticEvidenceCollection>> {
    const output = new Map<string, SomaticEvidenceCollection>(
      variants.map(variant => [
        variant.normalizedId,
        { records: [], unavailable: [] },
      ])
    );
    if (config.mode === "disabled") {
      for (const value of Array.from(output.values())) {
        value.unavailable.push("OncoKB:disabled");
      }
      return output;
    }
    if (config.mode !== "demo" && !config.token) {
      for (const value of Array.from(output.values())) {
        value.unavailable.push("OncoKB:api_token_missing");
      }
      return output;
    }
    const prepared = variants.flatMap(variant => {
      const query = prepareQuery(variant, tumor, config);
      return query ? [query] : [];
    });
    const preparedIds = new Set(
      prepared.map(item => item.variant.normalizedId)
    );
    for (const variant of variants) {
      if (!preparedIds.has(variant.normalizedId)) {
        output
          .get(variant.normalizedId)!
          .unavailable.push("OncoKB:unsupported_variant_representation");
      }
    }
    try {
      const annotations = await annotatePreparedQueries(
        prepared,
        config,
        fetchImpl
      );
      for (const [normalizedId, item] of Array.from(annotations.entries())) {
        const records = evidenceRecords(
          item.query,
          item.annotation,
          tumor,
          config
        );
        output.set(normalizedId, { records, unavailable: [] });
        const dataVersion = item.annotation.dataVersion;
        if (dataVersion) versions.OncoKB = dataVersion;
      }
    } catch (error) {
      const reason = unavailableReason(error);
      for (const item of prepared) {
        output.get(item.variant.normalizedId)!.unavailable.push(reason);
      }
    }
    return output;
  }

  return {
    knowledgeVersions: versions,
    collectBatch,
    async collect(variant, tumor) {
      const result = await collectBatch([variant], tumor);
      return (
        result.get(variant.normalizedId) ?? {
          records: [],
          unavailable: ["OncoKB:response_missing"],
        }
      );
    },
  };
}

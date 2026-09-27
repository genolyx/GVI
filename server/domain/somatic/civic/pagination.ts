import {
  CivicClientError,
  type CivicGraphQlClient,
  type CivicGraphQlResult,
} from "./client";
import type { CivicOperationName } from "./queries";
import type {
  CivicPageInfo,
  CivicProviderError,
  ProviderState,
  RawResponseEnvelope,
} from "./types";

export type CursorConnection<T> = {
  nodes: T[];
  pageInfo: CivicPageInfo;
  totalCount?: number;
};

export type PaginationResult<T> = {
  state: ProviderState;
  items: T[];
  completeness: {
    complete: boolean;
    pages: number;
    reason?: CivicProviderError["code"];
  };
  envelopes: RawResponseEnvelope[];
  errors: CivicProviderError[];
  warnings: string[];
};

export async function paginateCivic<TData, TNode>(options: {
  client: CivicGraphQlClient;
  operationName: CivicOperationName;
  variables: Record<string, unknown>;
  connection: (data: TData) => CursorConnection<TNode>;
  dedupeKey: (node: TNode) => string | number;
  maxPages?: number;
  deadlineMs?: number;
  now?: () => number;
}): Promise<PaginationResult<TNode>> {
  const maxPages = Math.max(1, options.maxPages ?? 100);
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(1, options.deadlineMs ?? 120_000);
  const records = new Map<string | number, TNode>();
  const seenCursors = new Set<string>();
  const envelopes: RawResponseEnvelope[] = [];
  const warnings: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let expectedTotal: number | undefined;

  function partial(
    code: CivicProviderError["code"],
    error?: CivicProviderError
  ): PaginationResult<TNode> {
    return {
      state: pages > 0 ? "PARTIAL" : "UNAVAILABLE",
      items: Array.from(records.values()),
      completeness: { complete: false, pages, reason: code },
      envelopes,
      errors: error ? [error] : [],
      warnings,
    };
  }

  while (pages < maxPages) {
    if (now() >= deadline) return partial("DEADLINE");
    let response: CivicGraphQlResult<TData>;
    try {
      response = await options.client.execute<TData>(options.operationName, {
        ...options.variables,
        after: cursor,
      });
    } catch (error) {
      if (error instanceof CivicClientError) {
        return partial(error.code, {
          code: error.code,
          retryable: error.retryable,
          requestId: error.requestId,
          message: error.message,
        });
      }
      throw error;
    }
    envelopes.push(response.envelope);
    const connection = options.connection(response.data);
    pages += 1;
    expectedTotal ??= connection.totalCount;
    for (const node of connection.nodes) {
      records.set(options.dedupeKey(node), node);
    }
    if (!connection.pageInfo.hasNextPage) {
      if (expectedTotal !== undefined && records.size !== expectedTotal) {
        warnings.push(`TOTAL_COUNT_MISMATCH:${expectedTotal}:${records.size}`);
      }
      return {
        state: records.size ? "COMPLETE" : "NO_EVIDENCE",
        items: Array.from(records.values()),
        completeness: { complete: true, pages },
        envelopes,
        errors: [],
        warnings,
      };
    }
    const next = connection.pageInfo.endCursor;
    if (!next || next === cursor || seenCursors.has(next)) {
      return partial("CURSOR_NOT_ADVANCING");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return partial("PAGE_LIMIT");
}

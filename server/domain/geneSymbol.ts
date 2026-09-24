/**
 * Workbench intake must name a real human gene. The classifier will still
 * finish a misspelled symbol such as CHCK2, and the review is then an empty VUS.
 * HGNC is the check: approved symbol, alias, or previous symbol.
 */

const HGNC = "https://rest.genenames.org/fetch";
const CACHE_MS = 60 * 60 * 1000;

type CacheHit = { symbol: string | null; at: number };
const cache = new Map<string, CacheHit>();

type HgncDoc = { symbol?: string };
type HgncPayload = { response?: { numFound?: number; docs?: HgncDoc[] } };

export type GeneCheck = { ok: true; symbol: string } | { ok: false; reason: string };

export function resetGeneSymbolCache() {
  cache.clear();
}

function normalize(raw: string) {
  return raw.trim().toUpperCase();
}

async function hgncLookup(kind: "symbol" | "alias_symbol" | "prev_symbol", symbol: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${HGNC}/${kind}/${encodeURIComponent(symbol)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HGNC returned ${response.status}`);
  const body = (await response.json()) as HgncPayload;
  const doc = body.response?.docs?.[0];
  if (!body.response?.numFound || !doc?.symbol) return null;
  return doc.symbol.trim().toUpperCase();
}

export async function checkHumanGeneSymbol(raw: string, fetchImpl: typeof fetch = fetch): Promise<GeneCheck> {
  const symbol = normalize(raw);
  if (!/^[A-Z][A-Z0-9-]{1,29}$/.test(symbol)) {
    return { ok: false, reason: `${raw.trim() || "This value"} is not a gene symbol.` };
  }
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.symbol
      ? { ok: true, symbol: cached.symbol }
      : { ok: false, reason: `${symbol} is not a recognized human gene symbol, so it was not queued.` };
  }
  try {
    const approved =
      (await hgncLookup("symbol", symbol, fetchImpl)) ||
      (await hgncLookup("alias_symbol", symbol, fetchImpl)) ||
      (await hgncLookup("prev_symbol", symbol, fetchImpl));
    cache.set(symbol, { symbol: approved, at: Date.now() });
    if (!approved) {
      return { ok: false, reason: `${symbol} is not a recognized human gene symbol, so it was not queued.` };
    }
    return { ok: true, symbol: approved };
  } catch {
    return { ok: false, reason: `Could not verify ${symbol} against HGNC. Try again in a moment.` };
  }
}

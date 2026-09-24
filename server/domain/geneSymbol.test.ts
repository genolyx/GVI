import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHumanGeneSymbol, resetGeneSymbolCache } from "./geneSymbol";

function hgnc(numFound: number, symbol?: string) {
  return {
    ok: true,
    json: async () => ({ response: { numFound, docs: symbol ? [{ symbol }] : [] } }),
  } as Response;
}

afterEach(() => {
  resetGeneSymbolCache();
  vi.unstubAllGlobals();
});

describe("checkHumanGeneSymbol", () => {
  it("accepts an approved HGNC symbol", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/symbol/CHEK2")) return hgnc(1, "CHEK2");
      return hgnc(0);
    });
    await expect(checkHumanGeneSymbol("chek2", fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
      symbol: "CHEK2",
    });
  });

  it("rejects a misspelling such as CHCK2", async () => {
    const fetchImpl = vi.fn(async () => hgnc(0));
    const result = await checkHumanGeneSymbol("CHCK2", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CHCK2/);
  });

  it("accepts a previous symbol and returns the approved one", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const value = String(url);
      if (value.includes("/symbol/") || value.includes("/alias_symbol/")) return hgnc(0);
      return hgnc(1, "CHEK2");
    });
    await expect(checkHumanGeneSymbol("RAD53", fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
      symbol: "CHEK2",
    });
  });
});

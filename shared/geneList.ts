const SKIP = new Set(["GENE", "GENES", "SYMBOL", "SYMBOLS", "HUGO", "HGNC", "PANEL", "TRANSCRIPT", "ID", "NAME", "CHROM", "POS"]);

/** Gene symbols from a pasted list or a panel file. Null when the text is empty. */
export function parseGeneList(raw: string): Set<string> | null {
  if (!raw.trim()) return null;
  const symbols = new Set<string>();
  for (const token of raw.split(/[\s,;|]+/)) {
    const upper = token.trim().toUpperCase();
    if (/^(?:NM|NR|XM|XR|NC|NG|NP|XP|ENST|ENSP)_/.test(upper)) continue;
    const symbol = upper.split(/[._]/)[0] || "";
    if (!/^[A-Z][A-Z0-9-]{1,19}$/.test(symbol) || SKIP.has(symbol)) continue;
    symbols.add(symbol);
  }
  return symbols;
}

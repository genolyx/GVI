const SKIP = new Set(["GENE", "GENES", "SYMBOL", "SYMBOLS", "HUGO", "HGNC", "PANEL", "TRANSCRIPT", "ID", "NAME", "CHROM", "POS"]);

/** Stable panel code Portal sends. Unique inside one organization. */
export function geneListCode(name: string, taken: Set<string>): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  let code = base.length >= 2 && /^[a-z0-9]/.test(base) ? base : "genes";
  if (!taken.has(code)) return code;
  let suffix = 2;
  while (taken.has(`${code}-${suffix}`)) suffix += 1;
  return `${code}-${suffix}`.slice(0, 80);
}

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

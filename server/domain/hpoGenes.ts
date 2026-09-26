import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HpoIndex = {
  byId: Map<string, Set<string>>;
  labelToId: Map<string, string>;
  labels: { id: string; name: string }[];
};

export type HpoMatch = {
  query: string;
  id: string;
  label: string;
  genes: string[];
};

const cache = new Map<string, { mtimeMs: number; index: HpoIndex }>();

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function hpoTablePath(): string {
  const override = (process.env.VC_HPO_PATH || "").trim();
  if (override) return expandHome(override);
  const root = expandHome((process.env.VC_DATA_ROOT || "").trim() || path.join(os.homedir(), "gvi-data"));
  return path.join(root, "reference", "hpo", "phenotype_to_genes.txt");
}

export function indexPhenotypeToGenes(text: string): HpoIndex {
  const byId = new Map<string, Set<string>>();
  const labelToId = new Map<string, string>();
  const labels: { id: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("hpo_id\t")) continue;
    const [idRaw, nameRaw, , symbolRaw] = line.split("\t");
    const id = (idRaw || "").trim().toUpperCase();
    const name = (nameRaw || "").trim();
    const symbol = (symbolRaw || "").trim().toUpperCase();
    if (!id.startsWith("HP:") || !symbol) continue;
    let genes = byId.get(id);
    if (!genes) {
      genes = new Set();
      byId.set(id, genes);
      if (name) {
        labelToId.set(normalizeLabel(name), id);
        labels.push({ id, name });
      }
    }
    genes.add(symbol);
  }
  return { byId, labelToId, labels };
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function loadHpoIndex(): Promise<HpoIndex | null> {
  const file = hpoTablePath();
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.index;
  const index = indexPhenotypeToGenes(await readFile(file, "utf8"));
  cache.set(file, { mtimeMs, index });
  return index;
}

export function genesForTerms(index: HpoIndex, raw: string): { matches: HpoMatch[]; unmatched: string[] } {
  const matches: HpoMatch[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,;]+/)) {
    const query = token.trim();
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    const idQuery = query.toUpperCase().replace(/\s+/g, "");
    const directId = /^HP:\d+$/.test(idQuery) ? idQuery : null;
    const exactId = directId && index.byId.has(directId) ? directId : index.labelToId.get(normalizeLabel(query)) || null;
    const ids = new Set<string>();
    if (exactId) ids.add(exactId);
    if (!directId && normalizeLabel(query).length >= 4) {
      const needle = normalizeLabel(query);
      const pattern = new RegExp(`(?:^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);
      for (const label of index.labels) {
        if (pattern.test(normalizeLabel(label.name))) ids.add(label.id);
      }
    }
    if (ids.size === 0) {
      unmatched.push(query);
      continue;
    }
    for (const id of ids) {
      const label = index.labels.find(item => item.id === id)?.name || id;
      matches.push({ query, id, label, genes: [...(index.byId.get(id) || [])].sort() });
    }
  }
  return { matches, unmatched };
}

export type HpoSuggestion = {
  id: string;
  name: string;
  geneCount: number;
};

function editDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[right.length] ?? max + 1;
}

/** Rank HPO labels by how close they are to what the user has typed. */
export function searchHpoTerms(index: HpoIndex, raw: string, limit = 8): HpoSuggestion[] {
  const query = normalizeLabel(raw);
  const compact = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const idDigits = compact.startsWith("HP") ? compact.slice(2) : /^\d+$/.test(compact) ? compact : "";
  if (query.length < 2 && idDigits.length < 3) return [];

  const ranked: { id: string; name: string; score: number }[] = [];
  for (const label of index.labels) {
    const name = normalizeLabel(label.name);
    const digits = label.id.slice(3);
    let score = 100;
    if (idDigits && digits === idDigits) score = 0;
    else if (idDigits.length >= 3 && digits.startsWith(idDigits)) score = 1;
    else if (query.length >= 2 && name === query) score = 2;
    else if (query.length >= 2 && name.startsWith(query)) score = 3;
    else if (query.length >= 2 && name.split(" ").some(word => word.startsWith(query))) score = 4;
    else if (query.length >= 4 && name.includes(query)) score = 5;
    else if (query.length >= 5) {
      const max = query.length >= 6 ? 2 : 1;
      let best = max + 1;
      for (const word of name.split(" ")) best = Math.min(best, editDistance(query, word, max));
      if (Math.abs(name.length - query.length) <= max) best = Math.min(best, editDistance(query, name, max));
      if (best <= max) score = 10 + best;
    }
    if (score < 100) ranked.push({ id: label.id, name: label.name, score });
  }
  ranked.sort((left, right) => left.score - right.score || left.name.length - right.name.length || left.name.localeCompare(right.name));
  return ranked.slice(0, limit).map(item => ({
    id: item.id,
    name: item.name,
    geneCount: index.byId.get(item.id)?.size ?? 0,
  }));
}

export function geneSetFromMatches(matches: HpoMatch[]): Set<string> {
  const genes = new Set<string>();
  for (const match of matches) {
    for (const gene of match.genes) genes.add(gene);
  }
  return genes;
}

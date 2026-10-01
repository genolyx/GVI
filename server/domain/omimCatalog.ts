import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One OMIM phenotype for a gene: disease entry, inheritance, and the OMIM page. */
export type OmimAssociation = {
  omimId: string;
  url: string;
  inheritance: string;
  disease: string;
};

type Cache = { path: string; mtimeMs: number; byGene: Map<string, OmimAssociation[]> };
let cache: Cache | null = null;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function omimCatalogPath(): string {
  const override = (process.env.VC_OMIM_PATH || "").trim();
  if (override) return expandHome(override);
  const root = expandHome(
    (process.env.VC_DATA_ROOT || "").trim() || path.join(os.homedir(), "gvi-data")
  );
  return path.join(root, "reference", "omim", "gold_omim.tsv");
}

/** AR, AD, or X-linked. Other OMIM modes are left off the variant table. */
export function shortInheritance(raw: string): string {
  const labels: string[] = [];
  const add = (label: string) => {
    if (!labels.includes(label)) labels.push(label);
  };
  for (const part of raw.split("/")) {
    const text = part.trim().replace(/^\?/, "").toLowerCase();
    if (!text) continue;
    if (text.startsWith("autosomal recessive") || text === "pseudoautosomal recessive") add("AR");
    else if (text.startsWith("autosomal dominant") || text === "pseudoautosomal dominant") add("AD");
    else if (text.includes("x-linked")) add("X-linked");
  }
  return labels.join("/");
}

function cleanDisease(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  return text.split(";")[0].trim();
}

/** Quoted TSV, including newlines inside clinical-note fields. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter(record => record.some(value => value.trim()));
}

export function indexOmimTable(text: string): Map<string, OmimAssociation[]> {
  const table = parseTsv(text);
  const header = table[0]?.map(name => name.trim()) ?? [];
  const at = (name: string) => header.indexOf(name);
  const geneAt = at("gene_symbol");
  const phenotypeAt = at("mim_phenotypes_id");
  const diseaseIdAt = at("mim_disease_id");
  const phenotypeNameAt = at("mim_phenotype_name");
  const diseaseNameAt = at("mim_disease_name");
  const inheritanceAt = at("mim_inheritance");
  const byGene = new Map<string, OmimAssociation[]>();
  if (geneAt < 0) return byGene;

  for (const cells of table.slice(1)) {
    const gene = (cells[geneAt] || "").trim().toUpperCase();
    const omimId = (cells[phenotypeAt] || cells[diseaseIdAt] || "").trim();
    if (!gene || !/^\d+$/.test(omimId)) continue;
    const disease =
      cleanDisease(cells[phenotypeNameAt] || "") || cleanDisease(cells[diseaseNameAt] || "");
    const inheritance = shortInheritance(cells[inheritanceAt] || "");
    const list = byGene.get(gene) ?? [];
    if (list.some(item => item.omimId === omimId && item.disease === disease && item.inheritance === inheritance)) {
      byGene.set(gene, list);
      continue;
    }
    list.push({
      omimId,
      url: `https://omim.org/entry/${omimId}`,
      inheritance,
      disease,
    });
    byGene.set(gene, list);
  }
  return byGene;
}

export async function loadOmimCatalog(): Promise<Map<string, OmimAssociation[]>> {
  const file = omimCatalogPath();
  try {
    const info = await stat(file);
    if (cache && cache.path === file && cache.mtimeMs === info.mtimeMs) return cache.byGene;
    const byGene = indexOmimTable(await readFile(file, "utf8"));
    cache = { path: file, mtimeMs: info.mtimeMs, byGene };
    return byGene;
  } catch {
    return new Map();
  }
}

export function omimForGene(
  catalog: Map<string, OmimAssociation[]>,
  gene: string | null | undefined
): OmimAssociation[] {
  const symbol = (gene || "").trim().toUpperCase();
  if (!symbol) return [];
  return catalog.get(symbol) ?? [];
}

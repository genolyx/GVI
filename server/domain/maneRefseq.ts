import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let byGene: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (byGene) return byGene;
  const path = join(dirname(fileURLToPath(import.meta.url)), "maneSelect.json");
  byGene = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return byGene;
}

/** MANE Select RefSeq accession for a gene, from MANE GRCh38 v1.3. */
export function maneRefseqForGene(gene: string | null | undefined): string | null {
  if (!gene) return null;
  return load()[gene.trim().toUpperCase()] ?? null;
}

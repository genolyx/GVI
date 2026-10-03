import { parseGeneList } from "./geneList";

export const GENE_SCOPE_REQUIRED =
  "Choose a gene panel or enter HPO terms before running this VCF.";

/** A saved panel, BED, gene list, or HPO text. HPO text still has to match genes on the server. */
export function hasGeneScopeChoice(input: {
  panelGenes?: number;
  panelRegions?: number;
  genes?: string;
  hpo?: string;
}): boolean {
  if ((input.panelGenes ?? 0) > 0 || (input.panelRegions ?? 0) > 0) return true;
  if ((input.hpo ?? "").trim()) return true;
  return Boolean(parseGeneList(input.genes ?? "")?.size);
}

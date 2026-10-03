import { TRPCError } from "@trpc/server";
import { GENE_SCOPE_REQUIRED, hasGeneScopeChoice } from "../../shared/geneScope";
import { geneSetFromMatches, genesForTerms, loadHpoIndex } from "./hpoGenes";
import type { VcfFilterInput } from "./vcfSelection";

const EMPTY_FILTERS: VcfFilterInput = {
  hpo: "",
  genes: "",
  maxAf: null,
  minQual: null,
  minGenotypeQuality: null,
  minDepth: null,
  passOnly: true,
  codingOnly: false,
  excludeClinvarBenign: false,
  excludeClinvarVus: false,
};

/**
 * Germline runs need a gene panel or HPO terms that map to genes.
 * When HPO is the only limit and it lives on the case, it is copied onto the filters.
 */
export async function resolveGermlineScope(input: {
  purpose: "germline" | "somatic";
  panel: { genes: readonly string[]; regions: readonly unknown[] | null } | null;
  filters: VcfFilterInput | null;
  phenotypeText?: string | null;
}): Promise<VcfFilterInput | null> {
  if (input.purpose !== "germline") return input.filters;
  const panelGenes = input.panel?.genes.length ?? 0;
  const panelRegions = input.panel?.regions?.length ?? 0;
  const geneList = input.filters?.genes ?? "";
  if (hasGeneScopeChoice({ panelGenes, panelRegions, genes: geneList, hpo: "" })) {
    return input.filters;
  }
  const hpo = (input.filters?.hpo || input.phenotypeText || "").trim();
  if (!hpo) {
    throw new TRPCError({ code: "BAD_REQUEST", message: GENE_SCOPE_REQUIRED });
  }
  const index = await loadHpoIndex();
  if (!index) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The HPO gene table is not installed, so phenotype terms cannot limit the VCF. Choose a gene panel.",
    });
  }
  const found = genesForTerms(index, hpo);
  if (geneSetFromMatches(found.matches).size === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Those HPO terms did not match any genes. Choose a gene panel or different HPO terms.",
    });
  }
  return { ...(input.filters ?? EMPTY_FILTERS), hpo };
}

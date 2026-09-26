import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { parseGeneList } from "@shared/geneList";
import { geneSetFromMatches, genesForTerms, loadHpoIndex } from "./hpoGenes";
import { parseVcf, type ParsedVariant } from "./vcf";
import { applyVcfFilters, type VcfFilters } from "./vcfFilter";

export const vcfFilterSchema = z.object({
  hpo: z.string().max(4000).default(""),
  genes: z.string().max(200_000).default(""),
  maxAf: z.number().min(0).max(1).nullable(),
  minQual: z.number().min(0).max(1_000_000).nullable(),
  minGenotypeQuality: z.number().min(0).max(100).nullable(),
  minDepth: z.number().int().min(0).max(100_000).nullable(),
  passOnly: z.boolean(),
  codingOnly: z.boolean(),
});

export type VcfFilterInput = z.infer<typeof vcfFilterSchema>;

const PARSE_LIMIT = 200_000;

export async function selectVcfRecords(text: string, referenceBuild: "GRCh37" | "GRCh38", filters: VcfFilterInput) {
  const parsed = parseVcf(text, referenceBuild, PARSE_LIMIT);
  let genes: VcfFilters["genes"] = null;
  let matches: { id: string; label: string; geneCount: number }[] = [];
  let unmatched: string[] = [];
  if (filters.hpo.trim()) {
    const index = await loadHpoIndex();
    if (!index) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The HPO gene table is not installed, so phenotype terms cannot limit the VCF.",
      });
    }
    const found = genesForTerms(index, filters.hpo);
    matches = found.matches.map(match => ({ id: match.id, label: match.label, geneCount: match.genes.length }));
    unmatched = found.unmatched;
    genes = geneSetFromMatches(found.matches);
  }
  const listed = parseGeneList(filters.genes);
  const panelGenes = listed && listed.size > 0 ? listed : null;
  const filtered = applyVcfFilters(parsed, {
    genes,
    panelGenes,
    maxAf: filters.maxAf,
    minQual: filters.minQual,
    minGenotypeQuality: filters.minGenotypeQuality,
    minDepth: filters.minDepth,
    passOnly: filters.passOnly,
    codingOnly: filters.codingOnly,
  });
  return {
    parsedCount: parsed.length,
    truncated: parsed.length >= PARSE_LIMIT,
    filtered,
    matches,
    unmatched,
    geneCount: genes?.size ?? null,
    panelCount: listed ? listed.size : null,
  };
}

/** Columns the variants table accepts. Quality fields stay off the row. */
export function variantInsertRow(variant: ParsedVariant) {
  const { siteQuality: _siteQuality, genotypeQuality: _genotypeQuality, callFilter: _callFilter, ...row } = variant;
  return row;
}

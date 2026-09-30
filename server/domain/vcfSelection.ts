import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { parseGeneList } from "@shared/geneList";
import { geneSetFromMatches, genesForTerms, loadHpoIndex } from "./hpoGenes";
import { parseVcf, type ParsedVariant } from "./vcf";
import type { GermlinePanelContent } from "./germlinePanel";
import { applyVcfFilters, type FilterReason, type VcfFilters } from "./vcfFilter";

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

export async function selectVcfRecords(
  text: string,
  referenceBuild: "GRCh37" | "GRCh38",
  filters: VcfFilterInput,
  panel?: GermlinePanelContent | null
) {
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
  const catalog = panel?.genes.length
    ? new Set(panel.genes.map(gene => gene.toUpperCase()))
    : null;
  let panelGenes = listed && listed.size > 0 ? listed : null;
  if (catalog) {
    panelGenes = panelGenes
      ? new Set(Array.from(panelGenes).filter(gene => catalog.has(gene)))
      : catalog;
  }
  let recordsWithoutGene = 0;
  let afFromInfoOnly = 0;
  for (const variant of parsed) {
    if (!variant.gene) recordsWithoutGene += 1;
    const info = variant.annotation.info;
    if (!info || typeof info !== "object") continue;
    const record = info as Record<string, unknown>;
    if (record.AF != null && record.gnomAD_AF == null && record.POP_AF == null) {
      afFromInfoOnly += 1;
    }
  }
  const hpoGeneCount = genes?.size ?? null;
  const hpoGenes = hpoGenesToApply(genes, parsed.length, recordsWithoutGene);
  const filtered = applyVcfFilters(parsed, {
    genes: hpoGenes,
    panelGenes,
    panelRegions: panel?.regions,
    maxAf: filters.maxAf,
    minQual: filters.minQual,
    minGenotypeQuality: filters.minGenotypeQuality,
    minDepth: filters.minDepth,
    passOnly: filters.passOnly,
    codingOnly: filters.codingOnly,
  });
  const notes: string[] = [];
  if (genes && hpoGenes === null && parsed.length > 0) {
    notes.push(
      `HPO terms were not applied because none of the ${parsed.length.toLocaleString("en-US")} records include a gene symbol.`
    );
  }
  if (filters.maxAf !== null && parsed.length > 0 && afFromInfoOnly === parsed.length) {
    notes.push(
      "Maximum allele frequency was not applied. This VCF has no gnomAD_AF or POP_AF, and INFO AF is the sample allele fraction."
    );
  }
  return {
    parsedCount: parsed.length,
    truncated: parsed.length >= PARSE_LIMIT,
    filtered,
    matches,
    unmatched,
    geneCount: hpoGeneCount,
    panelCount: panelGenes ? panelGenes.size : null,
    recordsWithoutGene,
    afFromInfoOnly,
    notes,
  };
}

/** Drop the HPO gene filter when it cannot match, so an unannotated VCF is not emptied. */
export function hpoGenesToApply(
  genes: ReadonlySet<string> | null,
  parsedCount: number,
  recordsWithoutGene: number
): ReadonlySet<string> | null {
  if (!genes || parsedCount === 0 || recordsWithoutGene === parsedCount) return null;
  return genes;
}

const DROP_ORDER: FilterReason[] = [
  "filter",
  "qual",
  "gq",
  "depth",
  "af",
  "impact",
  "hpo",
  "panel",
];

function dropReason(reason: FilterReason, filters: VcfFilterInput): string {
  if (reason === "filter") return "FILTER was not PASS";
  if (reason === "qual") return `QUAL was below ${filters.minQual}`;
  if (reason === "gq") return `genotype quality was below ${filters.minGenotypeQuality}`;
  if (reason === "depth") return `read depth was below ${filters.minDepth}`;
  if (reason === "af") return `allele frequency was above ${filters.maxAf}`;
  if (reason === "impact") return "the consequence was low-impact or modifier";
  if (reason === "hpo") return "the gene was missing or outside the HPO list";
  return "the variant was outside the gene list or panel";
}

/** Detail lines for a run that kept nothing. The short status sentence stays separate. */
export function emptyVcfSelectionLog(input: {
  parsedCount: number;
  truncated: boolean;
  dropped: Record<FilterReason, number>;
  filters: VcfFilterInput;
  geneCount: number | null;
  recordsWithoutGene: number;
  afFromInfoOnly: number;
}): string[] {
  const count = (value: number) => value.toLocaleString("en-US");
  const lines = [
    input.truncated
      ? `Read the first ${count(input.parsedCount)} variant records. Ingest stops at that limit.`
      : `Read ${count(input.parsedCount)} variant records.`,
  ];
  for (const reason of DROP_ORDER) {
    const removed = input.dropped[reason];
    if (!removed) continue;
    lines.push(`${count(removed)} removed because ${dropReason(reason, input.filters)}.`);
  }
  if (
    input.parsedCount > 0 &&
    input.afFromInfoOnly === input.parsedCount &&
    input.dropped.af > 0
  ) {
    lines.push(
      "Allele frequency came from the VCF INFO AF field because gnomAD_AF and POP_AF were absent. INFO AF is often the sample allele fraction, not a population frequency."
    );
  }
  if (input.filters.hpo.trim() && input.parsedCount > 0 && input.recordsWithoutGene === input.parsedCount) {
    const genes = input.geneCount ?? 0;
    lines.push(
      genes > 0
        ? `None of these records include a gene symbol, so the HPO list (${count(genes)} genes) cannot match a variant. The VCF needs a gene annotation such as GENE, SYMBOL, or SnpEff ANN.`
        : "The HPO terms did not match any genes."
    );
  }
  lines.push("Nothing was kept.");
  return lines;
}

/** Columns the variants table accepts. Quality fields stay off the row. */
export function variantInsertRow(variant: ParsedVariant) {
  const { siteQuality: _siteQuality, genotypeQuality: _genotypeQuality, callFilter: _callFilter, ...row } = variant;
  return row;
}

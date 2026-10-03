import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { parseGeneList } from "@shared/geneList";
import { FREQUENCY_TRACKS, type FrequencyTrack } from "@shared/germlineFrequency";
import { geneSetFromMatches, genesForTerms, loadHpoIndex } from "./hpoGenes";
import { combinedInheritance } from "./frequencyPolicy";
import { loadOmimCatalog } from "./omimCatalog";
import { parseVcf, type ParsedVariant } from "./vcf";
import type { GermlinePanelContent } from "./germlinePanel";
import { gnomadSiteKey, lookupLocalGnomad, type GnomadSite } from "./gnomadLocal";
import { applyVcfFilters, dropAboveMaxAf, type FilterReason, type VcfFilters } from "./vcfFilter";

export const vcfFilterSchema = z.object({
  hpo: z.string().max(4000).default(""),
  genes: z.string().max(200_000).default(""),
  maxAf: z.number().min(0).max(1).nullable(),
  minQual: z.number().min(0).max(1_000_000).nullable(),
  minGenotypeQuality: z.number().min(0).max(100).nullable(),
  minDepth: z.number().int().min(0).max(100_000).nullable(),
  passOnly: z.boolean(),
  codingOnly: z.boolean(),
  excludeClinvarBenign: z.boolean().default(false),
  excludeClinvarVus: z.boolean().default(false),
  track: z.enum(FREQUENCY_TRACKS).optional(),
});

export function withFrequencyTrack(
  filters: VcfFilterInput,
  track: FrequencyTrack
): VcfFilterInput {
  return {
    ...filters,
    track,
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
  };
}

export type VcfFilterInput = z.infer<typeof vcfFilterSchema>;

export async function selectVcfRecords(
  text: string,
  referenceBuild: "GRCh37" | "GRCh38",
  filters: VcfFilterInput,
  panel?: GermlinePanelContent | null,
  lookup: (sites: GnomadSite[]) => Promise<Map<string, number> | null> = lookupLocalGnomad
) {
  const parsed = parseVcf(text, referenceBuild);
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
    if (record.AF != null && variant.populationAf == null) {
      afFromInfoOnly += 1;
    }
  }
  const hpoGeneCount = genes?.size ?? null;
  const hpoGenes = hpoGenesToApply(genes, parsed.length, recordsWithoutGene);
  const inheritance = await inheritanceByGene();
  const track = filters.track ?? "carrier";
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
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
    track,
    inheritance,
  });
  const gnomadFilled = await fillMissingPopulationAf(
    filtered.kept,
    filters.maxAf,
    referenceBuild,
    lookup
  );
  const selected = gnomadFilled
    ? dropAboveMaxAf(filtered, filters.maxAf ?? 0, { track, inheritance })
    : filtered;
  const notes: string[] = [];
  if (genes && hpoGenes === null && parsed.length > 0) {
    notes.push(
      `HPO terms were not applied because none of the ${parsed.length.toLocaleString("en-US")} records include a gene symbol.`
    );
  }
  if (filters.maxAf !== null && parsed.length > 0 && afFromInfoOnly === parsed.length) {
    notes.push(
      gnomadFilled
        ? "This VCF has no gnomAD_AF or POP_AF. Missing frequencies were read from the local gnomAD file. INFO AF is the sample allele fraction and was not used."
        : "Maximum allele frequency was not applied. This VCF has no gnomAD_AF or POP_AF, and INFO AF is the sample allele fraction."
    );
  }
  return {
    parsedCount: parsed.length,
    truncated: false,
    filtered: selected,
    gnomadFilled,
    matches,
    unmatched,
    geneCount: hpoGeneCount,
    panelCount: panelGenes ? panelGenes.size : null,
    recordsWithoutGene,
    afFromInfoOnly,
    notes,
    steps: filterTimelineSteps({
      total: parsed.length,
      dropped: selected.dropped,
      filters,
      hpoApplied: hpoGenes !== null,
      hpoGeneCount,
      panelApplied: Boolean(panelGenes?.size || panel?.regions?.length),
    }),
  };
}

async function inheritanceByGene(): Promise<Map<string, string>> {
  const catalog = await loadOmimCatalog();
  const inheritance = new Map<string, string>();
  for (const [gene, rows] of catalog) {
    inheritance.set(gene, combinedInheritance(rows.map(row => row.inheritance)));
  }
  return inheritance;
}

async function fillMissingPopulationAf(
  variants: ParsedVariant[],
  maxAf: number | null,
  referenceBuild: "GRCh37" | "GRCh38",
  lookup: (sites: GnomadSite[]) => Promise<Map<string, number> | null>
): Promise<boolean> {
  if (maxAf === null || referenceBuild !== "GRCh38") return false;
  const missing = variants.filter(variant => variant.populationAf == null || variant.populationAf === "");
  if (!missing.length) return false;
  const frequencies = await lookup(missing);
  if (!frequencies) return false;
  let filled = false;
  for (const variant of missing) {
    const frequency = frequencies.get(gnomadSiteKey(variant));
    if (frequency === undefined) continue;
    variant.populationAf = String(frequency);
    filled = true;
  }
  return filled;
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
  "clinvar",
  "vus",
  "clinvarMix",
  "hpo",
  "panel",
];

export type FilterTimelineStep = {
  label: string;
  removed: number;
  remaining: number;
  detail: string | null;
};

/** Enabled filters in the same order as the first-fail check. gnomAD comes before HPO. */
export function filterTimelineSteps(input: {
  total: number;
  dropped: Record<FilterReason, number>;
  filters: VcfFilterInput;
  hpoApplied: boolean;
  hpoGeneCount: number | null;
  panelApplied: boolean;
}): FilterTimelineStep[] {
  const enabled: Array<{ reason: FilterReason; label: string; detail: string | null }> = [];
  if (input.filters.passOnly) {
    enabled.push({ reason: "filter", label: "FILTER is PASS", detail: null });
  }
  if (input.filters.minQual !== null) {
    enabled.push({
      reason: "qual",
      label: `QUAL is at least ${input.filters.minQual}`,
      detail: null,
    });
  }
  if (input.filters.minGenotypeQuality !== null) {
    enabled.push({
      reason: "gq",
      label: `Genotype quality is at least ${input.filters.minGenotypeQuality}`,
      detail: null,
    });
  }
  if (input.filters.minDepth !== null) {
    enabled.push({
      reason: "depth",
      label: `Read depth is at least ${input.filters.minDepth}`,
      detail: null,
    });
  }
  if (input.filters.maxAf !== null) {
    enabled.push({
      reason: "af",
      label: `gnomAD allele frequency is at most ${input.filters.maxAf}`,
      detail:
        "A plain ClinVar pathogenic or likely pathogenic call in an autosomal-recessive or X-linked gene stays above this limit. Hereditary cancer keeps that exception for autosomal-recessive genes, plus named founder alleles. Low-penetrance and risk-allele calls follow the limit. A missing frequency is read from the local gnomAD file. A site still missing there is kept.",
    });
  }
  if ((input.filters.track ?? "carrier") === "carrier") {
    enabled.push({
      reason: "vus",
      label: "ClinVar VUS is removed",
      detail:
        "Carrier screening removes Uncertain significance. Rare disease and hereditary cancer keep a VUS that is under the frequency limit. Benign and likely benign stay when they are under the limit.",
    });
  }
  if (input.filters.codingOnly) {
    enabled.push({
      reason: "impact",
      label: "Consequence is HIGH or MODERATE",
      detail: null,
    });
  }
  if (input.hpoApplied) {
    enabled.push({
      reason: "hpo",
      label: `Gene is in the HPO list (${(input.hpoGeneCount ?? 0).toLocaleString("en-US")} genes)`,
      detail: null,
    });
  }
  if (input.panelApplied) {
    enabled.push({
      reason: "panel",
      label: "Gene or region is in the panel",
      detail: null,
    });
  }
  let remaining = input.total;
  return enabled.map(step => {
    const removed = input.dropped[step.reason];
    remaining -= removed;
    return { label: step.label, removed, remaining, detail: step.detail };
  });
}

function dropReason(reason: FilterReason, filters: VcfFilterInput): string {
  if (reason === "filter") return "FILTER was not PASS";
  if (reason === "qual") return `QUAL was below ${filters.minQual}`;
  if (reason === "gq") return `genotype quality was below ${filters.minGenotypeQuality}`;
  if (reason === "depth") return `read depth was below ${filters.minDepth}`;
  if (reason === "af") return `allele frequency was above ${filters.maxAf}`;
  if (reason === "impact") return "the consequence was low-impact or modifier";
  if (reason === "clinvar") return "ClinVar was Benign, Likely benign, or Benign/Likely benign";
  if (reason === "vus") return "ClinVar was Uncertain significance on a carrier screen";
  if (reason === "clinvarMix") return "ClinVar was only VUS with Benign or Likely benign";
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
  gnomadFilled?: boolean;
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
      input.gnomadFilled
        ? "Missing frequencies were read from the local gnomAD file. INFO AF is the sample allele fraction and was not used."
        : "Allele frequency came from the VCF INFO AF field because gnomAD_AF and POP_AF were absent. INFO AF is often the sample allele fraction, not a population frequency."
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

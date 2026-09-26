export type FilterableVariant = {
  gene: string | null;
  transcript: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  populationAf: string | null;
  readDepth: number | null;
  impact: string;
  siteQuality: number | null;
  genotypeQuality: number | null;
  callFilter: string | null;
};

export type VcfFilters = {
  /** Null skips the HPO gene filter. An empty set drops every variant. */
  genes: ReadonlySet<string> | null;
  /** Null skips the panel or explicit gene list. */
  panelGenes: ReadonlySet<string> | null;
  maxAf: number | null;
  minQual: number | null;
  minGenotypeQuality: number | null;
  minDepth: number | null;
  passOnly: boolean;
  codingOnly: boolean;
};

export type FilterReason = "filter" | "qual" | "gq" | "depth" | "af" | "impact" | "hpo" | "panel";

export type FilteredVcf<T> = {
  total: number;
  kept: T[];
  classifiable: { gene: string; hgvsC: string; transcript: string | null; hgvsP: string | null }[];
  dropped: Record<FilterReason, number>;
  missingHgvs: number;
};

const emptyDrops = (): Record<FilterReason, number> => ({
  filter: 0,
  qual: 0,
  gq: 0,
  depth: 0,
  af: 0,
  impact: 0,
  hpo: 0,
  panel: 0,
});

export function codingHgvs(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/[cn]\.[A-Za-z0-9_>+-]+/);
  return match ? match[0] : null;
}

function alleleFrequency(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFail(variant: FilterableVariant, filters: VcfFilters): FilterReason | null {
  if (filters.passOnly && variant.callFilter && variant.callFilter !== "PASS") return "filter";
  if (filters.minQual !== null && variant.siteQuality !== null && variant.siteQuality < filters.minQual) return "qual";
  if (filters.minGenotypeQuality !== null && variant.genotypeQuality !== null && variant.genotypeQuality < filters.minGenotypeQuality) return "gq";
  if (filters.minDepth !== null && variant.readDepth !== null && variant.readDepth < filters.minDepth) return "depth";
  const af = alleleFrequency(variant.populationAf);
  if (filters.maxAf !== null && af !== null && af > filters.maxAf) return "af";
  if (filters.codingOnly && (variant.impact === "LOW" || variant.impact === "MODIFIER")) return "impact";
  const gene = (variant.gene || "").toUpperCase();
  if (filters.genes && (!gene || !filters.genes.has(gene))) return "hpo";
  if (filters.panelGenes && (!gene || !filters.panelGenes.has(gene))) return "panel";
  return null;
}

export function applyVcfFilters<T extends FilterableVariant>(variants: T[], filters: VcfFilters): FilteredVcf<T> {
  const dropped = emptyDrops();
  const kept: T[] = [];
  const classifiable: FilteredVcf["classifiable"] = [];
  const seen = new Set<string>();
  let missingHgvs = 0;
  for (const variant of variants) {
    const reason = firstFail(variant, filters);
    if (reason) {
      dropped[reason] += 1;
      continue;
    }
    kept.push(variant);
    const gene = (variant.gene || "").trim().toUpperCase();
    const hgvsC = codingHgvs(variant.hgvsC);
    if (!gene || !hgvsC) {
      missingHgvs += 1;
      continue;
    }
    const key = `${gene}|${hgvsC}`;
    if (seen.has(key)) continue;
    seen.add(key);
    classifiable.push({
      gene,
      hgvsC,
      transcript: variant.transcript,
      hgvsP: variant.hgvsP,
    });
  }
  return { total: variants.length, kept, classifiable, dropped, missingHgvs };
}

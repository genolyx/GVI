import type { FrequencyTrack } from "@shared/germlineFrequency";
import { keepsAtAnyFrequency, type FrequencyContext } from "./frequencyPolicy";
import { variantOverlapsPanel } from "./germlinePanel";

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
  clinvarSignificance?: string | null;
  chromosome?: string;
  position?: number;
  referenceAllele?: string;
};

export type VcfFilters = {
  /** Null skips the HPO gene filter. An empty set drops every variant. */
  genes: ReadonlySet<string> | null;
  /** Null or omitted skips the panel or explicit gene list. */
  panelGenes?: ReadonlySet<string> | null;
  /** Null skips coordinate filtering. Used for BED panels without relying on gene symbols. */
  panelRegions?: ReadonlyArray<{
    chromosome: string;
    start: number;
    end: number;
  }> | null;
  maxAf: number | null;
  minQual: number | null;
  minGenotypeQuality: number | null;
  minDepth: number | null;
  passOnly: boolean;
  codingOnly: boolean;
  /**
   * Stored for older jobs. ClinVar benign and VUS calls are no longer removed
   * from these flags. The track decides which ClinVar calls follow the frequency limit.
   */
  excludeClinvarBenign: boolean;
  excludeClinvarVus: boolean;
  /** Missing means carrier screening. */
  track?: FrequencyTrack;
  /** OMIM short labels keyed by gene symbol. An empty map grants no recessive exemption. */
  inheritance?: ReadonlyMap<string, string>;
};

export type FilterReason =
  | "filter"
  | "qual"
  | "gq"
  | "depth"
  | "af"
  | "impact"
  | "clinvar"
  | "vus"
  | "clinvarMix"
  | "hpo"
  | "panel";

export type FilteredVcf<T> = {
  total: number;
  kept: T[];
  classifiable: {
    gene: string;
    hgvsC: string;
    transcript: string | null;
    hgvsP: string | null;
  }[];
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
  clinvar: 0,
  vus: 0,
  clinvarMix: 0,
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

const BENIGN_CLINVAR = new Set(["benign", "likely benign"]);
const VUS_CLINVAR = new Set(["uncertain significance", "vus", "variant of uncertain significance"]);

function frequencyContext(filters: VcfFilters): FrequencyContext {
  return {
    track: filters.track ?? "carrier",
    inheritance: filters.inheritance ?? new Map(),
  };
}

function clinvarTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .split(/[&/,;]+/)
    .map(token => token.trim().replace(/\s+/g, " "))
    .filter(token => token && token !== "." && token !== "not provided");
}

/** True when every ClinVar call is Benign or Likely benign, including Benign/Likely benign. */
export function isClinvarBenignCall(value: string | null | undefined): boolean {
  const tokens = clinvarTokens(value);
  return tokens.length > 0 && tokens.every(token => BENIGN_CLINVAR.has(token));
}

/** True when every ClinVar call is Uncertain significance. */
export function isClinvarVusCall(value: string | null | undefined): boolean {
  const tokens = clinvarTokens(value);
  return tokens.length > 0 && tokens.every(token => VUS_CLINVAR.has(token));
}

/** True when the call mixes VUS with Benign or Likely benign and contains nothing else. */
export function isClinvarBenignVusMix(value: string | null | undefined): boolean {
  const tokens = clinvarTokens(value);
  if (!tokens.length) return false;
  let benign = false;
  let vus = false;
  for (const token of tokens) {
    if (BENIGN_CLINVAR.has(token)) benign = true;
    else if (VUS_CLINVAR.has(token)) vus = true;
    else return false;
  }
  return benign && vus;
}

function firstFail(
  variant: FilterableVariant,
  filters: VcfFilters
): FilterReason | null {
  if (filters.passOnly && variant.callFilter && variant.callFilter !== "PASS")
    return "filter";
  if (
    filters.minQual !== null &&
    variant.siteQuality !== null &&
    variant.siteQuality < filters.minQual
  )
    return "qual";
  if (
    filters.minGenotypeQuality !== null &&
    variant.genotypeQuality !== null &&
    variant.genotypeQuality < filters.minGenotypeQuality
  )
    return "gq";
  if (
    filters.minDepth !== null &&
    variant.readDepth !== null &&
    variant.readDepth < filters.minDepth
  )
    return "depth";
  const af = alleleFrequency(variant.populationAf);
  const aboveLimit =
    filters.maxAf !== null && af !== null && af > filters.maxAf;
  if (aboveLimit && !keepsAtAnyFrequency(variant, frequencyContext(filters))) return "af";
  if (
    (filters.track ?? "carrier") === "carrier" &&
    isClinvarVusCall(variant.clinvarSignificance)
  )
    return "vus";
  if (
    filters.codingOnly &&
    (variant.impact === "LOW" || variant.impact === "MODIFIER")
  )
    return "impact";
  const gene = (variant.gene || "").toUpperCase();
  if (filters.genes && (!gene || !filters.genes.has(gene))) return "hpo";
  const geneMatch =
    !filters.panelGenes || Boolean(gene && filters.panelGenes.has(gene));
  const regions = filters.panelRegions;
  const regionMatch =
    !regions?.length || variantOverlapsPanel(variant, regions);
  if (filters.panelGenes && regions?.length) {
    if (!geneMatch && !regionMatch) return "panel";
  } else if (!geneMatch || !regionMatch) {
    return "panel";
  }
  return null;
}

export function applyVcfFilters<T extends FilterableVariant>(
  variants: T[],
  filters: VcfFilters
): FilteredVcf<T> {
  const dropped = emptyDrops();
  const kept: T[] = [];
  const classifiable: FilteredVcf<T>["classifiable"] = [];
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

/** Second pass after a local gnomAD lookup fills frequencies the VCF left blank. */
export function dropAboveMaxAf<T extends FilterableVariant>(
  result: FilteredVcf<T>,
  maxAf: number,
  context?: FrequencyContext
): FilteredVcf<T> {
  const policy: FrequencyContext = context ?? {
    track: "carrier",
    inheritance: new Map(),
  };
  const dropped = { ...result.dropped };
  const kept: T[] = [];
  for (const variant of result.kept) {
    const af = alleleFrequency(variant.populationAf);
    if (af !== null && af > maxAf && !keepsAtAnyFrequency(variant, policy)) {
      dropped.af += 1;
      continue;
    }
    kept.push(variant);
  }
  const rebuilt = applyVcfFilters(kept, {
    genes: null,
    maxAf: null,
    minQual: null,
    minGenotypeQuality: null,
    minDepth: null,
    passOnly: false,
    codingOnly: false,
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
  });
  return {
    ...result,
    kept,
    dropped,
    classifiable: rebuilt.classifiable,
    missingHgvs: rebuilt.missingHgvs,
  };
}

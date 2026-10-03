import { INTRON_FLANK_BP, UTR_START_FLANK_BP, type FrequencyTrack } from "@shared/germlineFrequency";
import {
  isNamedReducedPenetrance,
  isPlainPathogenicCall,
  isReducedPenetranceCall,
  keepsAtAnyFrequency,
  type FrequencyContext,
} from "./frequencyPolicy";
import { variantOverlapsPanel } from "./germlinePanel";
import { gnomadSiteKey } from "./gnomadLocal";

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
  /** Sample GT, such as 0/1 or 1/1. */
  zygosity?: string | null;
  consequence?: string | null;
  chromosome?: string;
  position?: number;
  referenceAllele?: string;
  alternateAllele?: string;
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
  /**
   * Genomic sites a major laboratory called Benign or Likely benign.
   * Keys are chromosome:position:ref:alt. Omitted or empty skips this rule.
   */
  majorLabBenign?: ReadonlySet<string>;
};

export type FilterReason =
  | "filter"
  | "qual"
  | "gq"
  | "depth"
  | "af"
  | "impact"
  | "clinvar"
  | "lab"
  | "vus"
  | "clinvarMix"
  | "intron"
  | "utr"
  | "hpo"
  | "panel";

/** ClinVar drop that still passed the location, panel, frequency, and quality rules. */
export type HoldReason = "vus" | "benign" | "lab";

export type FilteredVcf<T> = {
  total: number;
  kept: T[];
  /**
   * Removed for a ClinVar VUS, a homozygous benign call, or a major-lab benign
   * submission, after the intron, UTR, panel, frequency, and quality rules passed.
   * These stay out of the classifier until a reviewer runs one.
   */
  held: { variant: T; reason: HoldReason }[];
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
  lab: 0,
  vus: 0,
  clinvarMix: 0,
  intron: 0,
  utr: 0,
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

/** True when both alleles are the same alternate allele. 1/0 and 0/1 stay heterozygous. */
export function isHomozygousGenotype(value: string | null | undefined): boolean {
  if (!value) return false;
  const alleles = value.trim().split(/[|/]/).filter(Boolean);
  if (alleles.length < 2) return false;
  return new Set(alleles).size === 1 && alleles[0] !== "0" && alleles[0] !== ".";
}

/** Intronic and other non-coding sites. Synonymous and splice-region calls stay coding. */
export function isNoncodingSite(variant: FilterableVariant): boolean {
  if (variant.impact === "MODIFIER") return true;
  const consequence = (variant.consequence ?? "").toLowerCase();
  return /(?:^|&)(?:intron_variant|5_prime_utr_variant|3_prime_utr_variant|upstream_gene_variant|downstream_gene_variant|intergenic_variant|non_coding_transcript_variant|non_coding_transcript_exon_variant)(?:&|$)/.test(
    consequence
  );
}

/**
 * Nearest intron distance in a coding HGVS such as c.1056+347805 or c.4-129.
 * Null when the allele is exonic, or when the change reaches both sides of an exon.
 */
export function nearestIntronOffset(hgvsC: string | null | undefined): number | null {
  if (!hgvsC) return null;
  const coding = hgvsC.match(/c\.[^\s]+/)?.[0] ?? hgvsC;
  const parts = [...coding.matchAll(/(\d+)([+-])(\d+)/g)];
  if (!parts.length) return null;
  const signs = new Set(parts.map(part => part[2]));
  const exons = new Set(parts.map(part => part[1]));
  if (signs.size > 1 && exons.size > 1) return null;
  const distances = parts
    .map(part => Number(part[3]))
    .filter(value => Number.isFinite(value));
  return distances.length ? Math.min(...distances) : null;
}

/**
 * Closest 5' UTR base to the start codon. Zero when the allele includes the ATG,
 * as in c.-7_1del. Null when the HGVS has no 5' UTR coordinate.
 */
export function fivePrimeStartDistance(hgvsC: string | null | undefined): number | null {
  if (!hgvsC) return null;
  const coding = hgvsC.match(/c\.[^\s]+/)?.[0];
  if (!coding || coding.includes("*")) return null;
  const distances = [...coding.matchAll(/-(\d+)/g)].map(part => Number(part[1]));
  if (!distances.length) return null;
  if (/_1(?!\d)/.test(coding)) return 0;
  return Math.min(...distances.filter(value => Number.isFinite(value)));
}

function isOutsideStartRegion(variant: FilterableVariant): boolean {
  const consequence = (variant.consequence ?? "").toLowerCase();
  if (
    consequence.includes("upstream_gene_variant") ||
    consequence.includes("downstream_gene_variant") ||
    consequence.includes("3_prime_utr_variant")
  ) {
    return true;
  }
  if (!consequence.includes("5_prime_utr_variant")) return false;
  const distance = fivePrimeStartDistance(variant.hgvsC);
  return distance !== null && distance > UTR_START_FLANK_BP;
}

function isReportedPathogenic(variant: FilterableVariant): boolean {
  if (isReducedPenetranceCall(variant.clinvarSignificance)) return false;
  if (isNamedReducedPenetrance(variant)) return false;
  return isPlainPathogenicCall(variant.clinvarSignificance);
}

function isIntronicSite(variant: FilterableVariant): boolean {
  const consequence = (variant.consequence ?? "").toLowerCase();
  return (
    consequence.includes("intron_variant") ||
    consequence.includes("splice_donor") ||
    consequence.includes("splice_acceptor") ||
    nearestIntronOffset(variant.hgvsC) !== null
  );
}

function isUtrSite(variant: FilterableVariant): boolean {
  const consequence = (variant.consequence ?? "").toLowerCase();
  if (
    consequence.includes("5_prime_utr_variant") ||
    consequence.includes("3_prime_utr_variant") ||
    consequence.includes("upstream_gene_variant") ||
    consequence.includes("downstream_gene_variant")
  ) {
    return true;
  }
  if (fivePrimeStartDistance(variant.hgvsC) !== null) return true;
  return /c\.\*/.test(variant.hgvsC ?? "");
}

function isBeyondIntronFlank(variant: FilterableVariant): boolean {
  const offset = nearestIntronOffset(variant.hgvsC);
  if (offset === null || offset <= INTRON_FLANK_BP) return false;
  const consequence = (variant.consequence ?? "").toLowerCase();
  return consequence.includes("intron_variant") || variant.impact === "MODIFIER";
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

function majorLabBenignSite(
  variant: FilterableVariant,
  sites: ReadonlySet<string> | undefined
): boolean {
  if (!sites?.size) return false;
  if (
    variant.chromosome == null ||
    variant.position == null ||
    !variant.referenceAllele ||
    !variant.alternateAllele
  ) {
    return false;
  }
  return sites.has(
    gnomadSiteKey({
      chromosome: variant.chromosome,
      position: variant.position,
      referenceAllele: variant.referenceAllele,
      alternateAllele: variant.alternateAllele,
    })
  );
}

/** True when the variant fails a rule other than the ClinVar VUS, benign, or lab drop. */
function failsOutsideClinvarHold(
  variant: FilterableVariant,
  filters: VcfFilters
): boolean {
  if (filters.passOnly && variant.callFilter && variant.callFilter !== "PASS") return true;
  if (
    filters.minQual !== null &&
    variant.siteQuality !== null &&
    variant.siteQuality < filters.minQual
  ) {
    return true;
  }
  if (
    filters.minGenotypeQuality !== null &&
    variant.genotypeQuality !== null &&
    variant.genotypeQuality < filters.minGenotypeQuality
  ) {
    return true;
  }
  if (
    filters.minDepth !== null &&
    variant.readDepth !== null &&
    variant.readDepth < filters.minDepth
  ) {
    return true;
  }
  const af = alleleFrequency(variant.populationAf);
  const aboveLimit = filters.maxAf !== null && af !== null && af > filters.maxAf;
  if (aboveLimit && !keepsAtAnyFrequency(variant, frequencyContext(filters))) return true;
  const track = filters.track ?? "carrier";
  if (track === "carrier") {
    if (isIntronicSite(variant) && !isReportedPathogenic(variant)) return true;
    if (isUtrSite(variant) && !isReportedPathogenic(variant)) return true;
  } else if (track !== "none") {
    if (isBeyondIntronFlank(variant) && !keepsAtAnyFrequency(variant, frequencyContext(filters))) {
      return true;
    }
    if (isOutsideStartRegion(variant) && !keepsAtAnyFrequency(variant, frequencyContext(filters))) {
      return true;
    }
  }
  if (filters.codingOnly && (variant.impact === "LOW" || variant.impact === "MODIFIER")) return true;
  const gene = (variant.gene || "").toUpperCase();
  if (filters.genes && (!gene || !filters.genes.has(gene))) return true;
  const geneMatch = !filters.panelGenes || Boolean(gene && filters.panelGenes.has(gene));
  const regions = filters.panelRegions;
  const regionMatch = !regions?.length || variantOverlapsPanel(variant, regions);
  if (filters.panelGenes && regions?.length) {
    if (!geneMatch && !regionMatch) return true;
  } else if (!geneMatch || !regionMatch) {
    return true;
  }
  return false;
}

/**
 * Carrier holds a benign call only when it is non-coding or homozygous, so a
 * heterozygous coding benign call can still be upgraded.
 * Rare disease and hereditary cancer hold every Benign or Likely benign call.
 */
function benignCallIsHeld(variant: FilterableVariant, track: string): boolean {
  if (track === "carrier") return isNoncodingSite(variant) || isHomozygousGenotype(variant.zygosity);
  return track === "rare_disease" || track === "hereditary_cancer";
}

/**
 * A ClinVar removal that belongs on the review tab.
 * Off-target, deep-intron, and UTR drops stay out of this list.
 */
export function clinvarHoldReason(
  variant: FilterableVariant,
  filters: VcfFilters
): HoldReason | null {
  const track = filters.track ?? "carrier";
  if (track === "none") return null;
  if (failsOutsideClinvarHold(variant, filters)) return null;
  if (track === "carrier" && isClinvarVusCall(variant.clinvarSignificance)) return "vus";
  if (isClinvarBenignCall(variant.clinvarSignificance) && benignCallIsHeld(variant, track)) {
    return "benign";
  }
  if (majorLabBenignSite(variant, filters.majorLabBenign)) return "lab";
  return null;
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
  const track = filters.track ?? "carrier";
  if (track === "carrier" && isClinvarVusCall(variant.clinvarSignificance)) return "vus";
  if (
    track !== "none" &&
    isClinvarBenignCall(variant.clinvarSignificance) &&
    benignCallIsHeld(variant, track)
  )
    return "clinvar";
  if (track !== "none" && majorLabBenignSite(variant, filters.majorLabBenign)) return "lab";
  if (track === "carrier") {
    if (isIntronicSite(variant) && !isReportedPathogenic(variant)) return "intron";
    if (isUtrSite(variant) && !isReportedPathogenic(variant)) return "utr";
  } else if (track !== "none") {
    if (isBeyondIntronFlank(variant) && !keepsAtAnyFrequency(variant, frequencyContext(filters)))
      return "intron";
    if (isOutsideStartRegion(variant) && !keepsAtAnyFrequency(variant, frequencyContext(filters)))
      return "utr";
  }
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
  const held: FilteredVcf<T>["held"] = [];
  const classifiable: FilteredVcf<T>["classifiable"] = [];
  const seen = new Set<string>();
  let missingHgvs = 0;
  for (const variant of variants) {
    const reason = firstFail(variant, filters);
    if (reason) {
      dropped[reason] += 1;
      const hold = clinvarHoldReason(variant, filters);
      if (hold) held.push({ variant, reason: hold });
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
  return { total: variants.length, kept, held, classifiable, dropped, missingHgvs };
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
  const held = (result.held ?? []).filter(item => {
    const af = alleleFrequency(item.variant.populationAf);
    return af === null || af <= maxAf || keepsAtAnyFrequency(item.variant, policy);
  });
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
    held,
    dropped,
    classifiable: rebuilt.classifiable,
    missingHgvs: rebuilt.missingHgvs,
  };
}

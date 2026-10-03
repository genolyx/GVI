/** Which frequency rules a case uses. The order's test type picks the track. */
export const FREQUENCY_TRACKS = ["carrier", "rare_disease", "hereditary_cancer", "none"] as const;

export type FrequencyTrack = (typeof FREQUENCY_TRACKS)[number];

/** 0.1% as a population-frequency fraction. 0.05 in the same field is 5%. */
export const DEFAULT_MAX_ALLELE_FREQUENCY = 0.001;

/**
 * Intronic sites farther than this from the exon are removed on the clinical tracks.
 * Twenty bases covers the splice region and the polypyrimidine tract.
 */
export const INTRON_FLANK_BP = 20;

/**
 * 5' UTR variants farther than this from the start codon are removed.
 * Fifteen bases covers the Kozak sequence and an indel that reaches the ATG.
 */
export const UTR_START_FLANK_BP = 15;

export const FREQUENCY_TRACK_LABEL: Record<FrequencyTrack, string> = {
  carrier: "Carrier screening",
  rare_disease: "Rare disease",
  hereditary_cancer: "Hereditary cancer",
  none: "No test type",
};

export function frequencyTrackForOrder(input: {
  testCategory?: string | null;
  packageCode?: string | null;
  otherTestType?: string | null;
}): FrequencyTrack {
  const packageCode = (input.packageCode ?? "").trim();
  const program = (input.otherTestType ?? "").trim() || packageCode;
  if (program === "HereditaryCancer" || packageCode === "HereditaryCancer") {
    return "hereditary_cancer";
  }
  if (
    packageCode === "WholeExome" ||
    (input.testCategory ?? "").trim() === "whole_exome" ||
    program === "WGS" ||
    program.startsWith("Exome")
  ) {
    return "rare_disease";
  }
  return "carrier";
}

export function frequencyTrackSummary(track: FrequencyTrack): string {
  if (track === "none") {
    return "ClinVar and inheritance rules are off. A variant is removed only when it misses FILTER PASS or is outside the allele frequency, QUAL, genotype quality, or read depth limits. A gene list or panel still applies.";
  }
  const lab =
    "A Benign or Likely benign submission from GeneDx, Invitae, Labcorp, Natera, Baylor Genetics, Ambry Genetics, Blueprint Genetics, PreventionGenetics, or Fulgent Genetics removes the variant.";
  const benign =
    track === "carrier"
      ? "A benign or likely benign call is removed when the site is non-coding or intronic, and when the genotype is homozygous. A heterozygous coding benign or likely benign call stays under the frequency limit."
      : "A Benign or Likely benign call is set aside and is not classified until it is run.";
  const intron = `An intronic variant more than ${INTRON_FLANK_BP} bp from the exon is removed. A plain pathogenic or likely pathogenic call beyond that distance can still stay.`;
  const utr = `A 5' UTR variant stays when it is within ${UTR_START_FLANK_BP} bp of the start codon. Other 5' UTR variants, the 3' UTR, and upstream or downstream variants are removed. A plain pathogenic or likely pathogenic call can still stay.`;
  if (track === "hereditary_cancer") {
    return `ClinVar VUS calls stay when they are under the frequency limit. ${benign} ${lab} ${intron} ${utr} A plain pathogenic or likely pathogenic call stays at any frequency when the gene is autosomal dominant or autosomal recessive. Low-penetrance and risk-allele calls follow the limit.`;
  }
  if (track === "rare_disease") {
    return `ClinVar VUS calls stay when they are under the frequency limit. ${benign} ${lab} ${intron} ${utr} A plain pathogenic or likely pathogenic call stays at any frequency when the gene is autosomal dominant, autosomal recessive, or X-linked. Low-penetrance and risk-allele calls follow the limit.`;
  }
  return `ClinVar VUS calls are removed. ${benign} ${lab} An intronic or UTR variant stays only when ClinVar calls it pathogenic or likely pathogenic. A low-penetrance or risk-allele call is removed. A plain pathogenic or likely pathogenic call stays at any frequency when the gene is autosomal dominant, autosomal recessive, or X-linked. Low-penetrance and risk-allele calls follow the limit.`;
}

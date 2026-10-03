/** Which frequency rules a case uses. The order's test type picks the track. */
export const FREQUENCY_TRACKS = ["carrier", "rare_disease", "hereditary_cancer"] as const;

export type FrequencyTrack = (typeof FREQUENCY_TRACKS)[number];

/** 0.1% as a population-frequency fraction. 0.05 in the same field is 5%. */
export const DEFAULT_MAX_ALLELE_FREQUENCY = 0.001;

export const FREQUENCY_TRACK_LABEL: Record<FrequencyTrack, string> = {
  carrier: "Carrier screening",
  rare_disease: "Rare disease",
  hereditary_cancer: "Hereditary cancer",
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
  if (track === "hereditary_cancer") {
    return "ClinVar VUS calls stay when they are under the frequency limit. A plain pathogenic or likely pathogenic call stays at any frequency only when the gene is autosomal recessive. Ashkenazi BRCA1 and BRCA2 founders and CHEK2 c.1100del stay at any frequency. Low-penetrance and risk-allele calls follow the limit.";
  }
  if (track === "rare_disease") {
    return "ClinVar VUS, benign, and likely benign stay when they are under the frequency limit. A plain pathogenic or likely pathogenic call in an autosomal-recessive or X-linked gene stays at any frequency. Low-penetrance and risk-allele calls follow the limit.";
  }
  return "ClinVar VUS calls are removed. Benign and likely benign stay when they are under the frequency limit, so a call can still be upgraded. A plain pathogenic or likely pathogenic call in an autosomal-recessive or X-linked gene stays at any frequency. Low-penetrance and risk-allele calls follow the limit.";
}

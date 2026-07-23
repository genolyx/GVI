export const ACMG_CRITERIA = [
  "PVS1",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PM1",
  "PM2",
  "PM3",
  "PM4",
  "PM5",
  "PM6",
  "PP1",
  "PP2",
  "PP3",
  "PP4",
  "PP5",
  "BA1",
  "BS1",
  "BS2",
  "BS3",
  "BS4",
  "BP1",
  "BP2",
  "BP3",
  "BP4",
  "BP5",
  "BP6",
  "BP7",
] as const;

export const GERMLINE_CLASSIFICATIONS = [
  "Pathogenic",
  "Likely Pathogenic",
  "VUS",
  "Likely Benign",
  "Benign",
] as const;

export const SOMATIC_TIERS = ["Tier I", "Tier II", "Tier III", "Tier IV"] as const;

export const ONCOGENICITY_CLASSIFICATIONS = [
  "Oncogenic",
  "Likely Oncogenic",
  "VUS",
  "Likely Benign",
  "Benign",
] as const;

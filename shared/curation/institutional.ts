/** Curator-saved calls, matching SAM-VC's institutional classification list. */
export const INSTITUTIONAL_CLASSIFICATIONS = [
  { label: "Pathogenic (P)", short: "P", class: "pathogenic" },
  { label: "Likely Pathogenic (LP)", short: "LP", class: "pathogenic" },
  { label: "VUS Pathogenic (VUSP)", short: "VUSP", class: "vus" },
  { label: "VUS", short: "VUS", class: "vus" },
  { label: "VUS Benign (VUSB)", short: "VUSB", class: "vus" },
  { label: "Likely Benign (LB)", short: "LB", class: "benign" },
  { label: "Benign (B)", short: "B", class: "benign" },
] as const;

export type InstitutionalClass = (typeof INSTITUTIONAL_CLASSIFICATIONS)[number]["class"];

export function institutionalClassForLabel(label: string): InstitutionalClass {
  return INSTITUTIONAL_CLASSIFICATIONS.find(option => option.label === label)?.class ?? "vus";
}

/** ACMG five-tier call, written onto the review page's institutional list. */
const ACMG_INSTITUTIONAL_LABEL: Record<string, string> = {
  Pathogenic: "Pathogenic (P)",
  "Likely Pathogenic": "Likely Pathogenic (LP)",
  VUS: "VUS",
  "Likely Benign": "Likely Benign (LB)",
  Benign: "Benign (B)",
};

export function institutionalLabelForAcmg(classification: string): string {
  return ACMG_INSTITUTIONAL_LABEL[classification] ?? "VUS";
}

/** Table and menu text: P, LP, VUS, LB, B, plus VUSP and VUSB. */
export function shortCallLabel(value: string | null | undefined): string {
  const text = (value || "").trim();
  if (!text) return "";
  const saved = INSTITUTIONAL_CLASSIFICATIONS.find(option => option.label === text);
  if (saved) return saved.short;
  const mapped = ACMG_INSTITUTIONAL_LABEL[text];
  if (!mapped) return text;
  return INSTITUTIONAL_CLASSIFICATIONS.find(option => option.label === mapped)?.short ?? text;
}

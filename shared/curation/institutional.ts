/** Curator-saved calls, matching SAM-VC's institutional classification list. */
export const INSTITUTIONAL_CLASSIFICATIONS = [
  { label: "Pathogenic (P)", class: "pathogenic" },
  { label: "Likely Pathogenic (LP)", class: "pathogenic" },
  { label: "VUS Pathogenic (VUSP)", class: "vus" },
  { label: "VUS", class: "vus" },
  { label: "VUS Benign (VUSB)", class: "vus" },
  { label: "Likely Benign (LB)", class: "benign" },
  { label: "Benign (B)", class: "benign" },
] as const;

export type InstitutionalClass = (typeof INSTITUTIONAL_CLASSIFICATIONS)[number]["class"];

export function institutionalClassForLabel(label: string): InstitutionalClass {
  return INSTITUTIONAL_CLASSIFICATIONS.find(option => option.label === label)?.class ?? "vus";
}

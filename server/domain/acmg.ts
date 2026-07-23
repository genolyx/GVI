import {
  ACMG_CRITERIA,
  GERMLINE_CLASSIFICATIONS,
  type GERMLINE_CLASSIFICATIONS as GermlineClassificationArray,
} from "../../shared/clinical-standards";

export type AcmgCode = (typeof ACMG_CRITERIA)[number];
export type GermlineClassification = (typeof GERMLINE_CLASSIFICATIONS)[number];

const BENIGN_STANDALONE = new Set<AcmgCode>(["BA1"]);
const BENIGN_STRONG = new Set<AcmgCode>(["BS1", "BS2", "BS3", "BS4"]);
const BENIGN_SUPPORTING = new Set<AcmgCode>(["BP1", "BP2", "BP3", "BP4", "BP5", "BP6", "BP7"]);

export type AcmgSuggestion = {
  classification: GermlineClassification;
  rationale: string;
  conflict: boolean;
  counts: { veryStrong: number; strong: number; moderate: number; supporting: number; benignStrong: number; benignSupporting: number };
};

export function suggestAcmgClassification(metCodes: readonly AcmgCode[]): AcmgSuggestion {
  const unique = new Set(metCodes);
  const codes = Array.from(unique);
  const veryStrong = unique.has("PVS1") ? 1 : 0;
  const strong = codes.filter(code => /^PS[1-4]$/.test(code)).length;
  const moderate = codes.filter(code => /^PM[1-6]$/.test(code)).length;
  const supporting = codes.filter(code => /^PP[1-5]$/.test(code)).length;
  const benignStandalone = codes.filter(code => BENIGN_STANDALONE.has(code)).length;
  const benignStrong = codes.filter(code => BENIGN_STRONG.has(code)).length;
  const benignSupporting = codes.filter(code => BENIGN_SUPPORTING.has(code)).length;
  const hasPathogenicEvidence = veryStrong + strong + moderate + supporting > 0;
  const hasBenignEvidence = benignStandalone + benignStrong + benignSupporting > 0;
  const counts = { veryStrong, strong, moderate, supporting, benignStrong, benignSupporting };

  if (hasPathogenicEvidence && hasBenignEvidence) {
    return {
      classification: "VUS",
      rationale: "Both pathogenic and benign evidence applied — expert review of conflicting evidence required.",
      conflict: true,
      counts,
    };
  }
  if (benignStandalone >= 1 || benignStrong >= 2) {
    return { classification: "Benign", rationale: "Meets ACMG 2015 benign combination criteria.", conflict: false, counts };
  }
  if ((benignStrong >= 1 && benignSupporting >= 1) || benignSupporting >= 2) {
    return { classification: "Likely Benign", rationale: "Meets ACMG 2015 likely benign combination criteria.", conflict: false, counts };
  }
  const pathogenic =
    (veryStrong >= 1 && strong >= 1) ||
    (veryStrong >= 1 && moderate >= 2) ||
    (veryStrong >= 1 && moderate >= 1 && supporting >= 1) ||
    (veryStrong >= 1 && supporting >= 2) ||
    strong >= 2 ||
    (strong >= 1 && moderate >= 3) ||
    (strong >= 1 && moderate >= 2 && supporting >= 2) ||
    (strong >= 1 && moderate >= 1 && supporting >= 4);
  if (pathogenic) {
    return { classification: "Pathogenic", rationale: "Meets ACMG 2015 pathogenic combination criteria.", conflict: false, counts };
  }
  const likelyPathogenic =
    (veryStrong >= 1 && moderate >= 1) ||
    (strong >= 1 && moderate >= 1) ||
    (strong >= 1 && supporting >= 2) ||
    moderate >= 3 ||
    (moderate >= 2 && supporting >= 2) ||
    (moderate >= 1 && supporting >= 4);
  if (likelyPathogenic) {
    return { classification: "Likely Pathogenic", rationale: "Meets ACMG 2015 likely pathogenic combination criteria.", conflict: false, counts };
  }
  return {
    classification: "VUS",
    rationale: "Selected criteria alone do not satisfy pathogenic or benign combination requirements.",
    conflict: false,
    counts,
  };
}

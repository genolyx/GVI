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
      rationale: "병원성 및 양성 근거가 함께 적용되어 전문가의 상충 근거 검토가 필요합니다.",
      conflict: true,
      counts,
    };
  }
  if (benignStandalone >= 1 || benignStrong >= 2) {
    return { classification: "Benign", rationale: "ACMG 2015 양성 조합 기준을 충족합니다.", conflict: false, counts };
  }
  if ((benignStrong >= 1 && benignSupporting >= 1) || benignSupporting >= 2) {
    return { classification: "Likely Benign", rationale: "ACMG 2015 가능성 높은 양성 조합 기준을 충족합니다.", conflict: false, counts };
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
    return { classification: "Pathogenic", rationale: "ACMG 2015 병원성 조합 기준을 충족합니다.", conflict: false, counts };
  }
  const likelyPathogenic =
    (veryStrong >= 1 && moderate >= 1) ||
    (strong >= 1 && moderate >= 1) ||
    (strong >= 1 && supporting >= 2) ||
    moderate >= 3 ||
    (moderate >= 2 && supporting >= 2) ||
    (moderate >= 1 && supporting >= 4);
  if (likelyPathogenic) {
    return { classification: "Likely Pathogenic", rationale: "ACMG 2015 가능성 높은 병원성 조합 기준을 충족합니다.", conflict: false, counts };
  }
  return {
    classification: "VUS",
    rationale: "선택된 기준만으로는 병원성 또는 양성 조합 기준을 충족하지 않습니다.",
    conflict: false,
    counts,
  };
}

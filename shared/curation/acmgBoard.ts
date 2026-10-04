import type { CurationCriterion } from "./document";
import type { HgmdPs4Check } from "./hgmdPs4";

/**
 * ACMG 2015 codes the classifier can decide from the variant record.
 * A code is listed here only when `apply_acmg` can emit it. PP5 and BP6 are
 * retired and stay off this board unless a reviewer already applied one.
 */
export const WIRED_ACMG: readonly { code: string; detail: string }[] = [
  { code: "PVS1", detail: "Null, frameshift, start-loss, or canonical splice when loss of function is the mechanism." },
  { code: "PS1", detail: "The same amino-acid change is already pathogenic." },
  { code: "PM1", detail: "Mutational hotspot or well-established functional domain." },
  { code: "PM2", detail: "Absent or extremely rare in population databases." },
  { code: "PM4", detail: "In-frame length change, stop-loss, or a small in-frame splice skip." },
  { code: "PM5", detail: "A different pathogenic missense at this residue." },
  { code: "PP3", detail: "Computational evidence supports a damaging effect." },
  { code: "BA1", detail: "Allele frequency is high enough to be stand-alone benign." },
  { code: "BS1", detail: "Allele frequency is greater than expected for the disorder." },
  { code: "BS2", detail: "Observed as a homozygote in population data." },
  { code: "BP4", detail: "Computational evidence suggests no impact." },
  { code: "BP7", detail: "Synonymous change, no predicted splice effect, and the nucleotide is not highly conserved." },
];

/**
 * Codes that still need a person. The engine does not score family, functional,
 * or case-count evidence, and it does not apply PP2, BP1, or BP3.
 */
export const MANUAL_ACMG: readonly { code: string; detail: string }[] = [
  { code: "PS2", detail: "De novo, with parental relationships confirmed." },
  { code: "PS3", detail: "Well-established functional studies show a damaging effect." },
  { code: "PS4", detail: "The variant is more common in affected people than in controls." },
  { code: "PM3", detail: "In trans with a pathogenic variant, for a recessive disorder." },
  { code: "PM6", detail: "Assumed de novo, without confirmed parental relationships." },
  { code: "PP1", detail: "Cosegregation with disease in the family." },
  { code: "PP2", detail: "Missense in a gene where missense is a common cause and benign missense is rare." },
  { code: "PP4", detail: "The phenotype is highly specific for this gene." },
  { code: "BS3", detail: "Well-established functional studies show no damaging effect." },
  { code: "BS4", detail: "Lack of segregation in affected members of a family." },
  { code: "BP1", detail: "Missense in a gene where only loss of function causes disease." },
  { code: "BP2", detail: "In trans with a pathogenic variant, or in cis with one, where that observation is benign." },
  { code: "BP3", detail: "In-frame insertion or deletion in a repetitive region." },
  { code: "BP5", detail: "Found in a case with an alternate molecular cause." },
];

export type AcmgBoardEntry = { code: string; detail: string };

export type AcmgEvidenceBoard = {
  found: CurationCriterion[];
  wired: AcmgBoardEntry[];
  manual: AcmgBoardEntry[];
};

/**
 * Codes a reviewer has taken off the call. They leave the found column so they
 * can be applied again from the wired or lookup list.
 */
export function withoutRemovedCriteria(
  criteria: readonly CurationCriterion[],
  saved: readonly { code: string; state: string }[] | null | undefined
): CurationCriterion[] {
  const removed = new Set(
    (saved ?? [])
      .filter(item => item.state === "not_met" || item.state === "not_applicable")
      .map(item => item.code)
  );
  if (!removed.size) return [...criteria];
  return criteria.filter(item => !removed.has(item.baseCode));
}

/** Split the ACMG list into evidence on this variant, wired checks that did not fire, and manual lookups. */
export function acmgEvidenceBoard(
  criteria: readonly CurationCriterion[],
  ps4?: HgmdPs4Check | null
): AcmgEvidenceBoard {
  const foundCodes = new Set(criteria.map(item => item.baseCode));
  return {
    found: [...criteria],
    wired: WIRED_ACMG.filter(item => !foundCodes.has(item.code)).map(item => ({ ...item })),
    manual: MANUAL_ACMG.filter(item => !foundCodes.has(item.code)).map(item =>
      item.code === "PS4" && ps4
        ? {
            code: "PS4",
            detail: `Suggestive. ${ps4.note} It is not in the classification until you apply it.`,
          }
        : { ...item }
    ),
  };
}

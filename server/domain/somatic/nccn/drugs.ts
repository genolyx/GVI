/** Drug and regimen identity for NCCN. Names from OncoKB are not used as NCCN regimens. */

export type DrugSource = "oncokb" | "civic" | "nccn" | "rxnorm" | "ncit";

export type DrugAlias = {
  source: DrugSource;
  kind: "generic" | "brand" | "abbreviation" | "biosimilar";
  name: string;
};

export type ApprovalState = "approved" | "not_approved" | "unknown";

export type DrugRecord = {
  id: string;
  aliases: DrugAlias[];
  classIds: string[];
  fda: ApprovalState;
  mfds: ApprovalState;
  offLabel: boolean;
};

export type DrugClass = {
  id: string;
  memberDrugIds: string[];
};

export type RegimenDefinition = {
  id: string;
  drugIds: string[];
  combinationType: "monotherapy" | "combination" | "sequential";
  orderMatters: boolean;
};

export type DrugCatalog = {
  version: string;
  drugs: DrugRecord[];
  classes: DrugClass[];
  regimens: RegimenDefinition[];
};

export const EMPTY_DRUG_CATALOG: DrugCatalog = {
  version: "none",
  drugs: [],
  classes: [],
  regimens: [],
};

function same(left: string, right: string) {
  return left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

/** One internal id. An ambiguous or unknown name stays unmapped. */
export function resolveDrugId(
  catalog: DrugCatalog,
  name: string,
  source?: DrugSource
): string | null {
  const hits = catalog.drugs.filter(drug =>
    drug.aliases.some(
      alias => same(alias.name, name) && (!source || alias.source === source)
    )
  );
  return hits.length === 1 ? hits[0].id : null;
}

/** Dose and schedule are ignored. Order matters only when the regimen says so. */
export function regimenIdentity(regimen: RegimenDefinition): string {
  const drugs = regimen.orderMatters
    ? regimen.drugIds
    : [...regimen.drugIds].sort();
  return `${regimen.combinationType}:${drugs.join("+")}`;
}

export function regimensEquivalent(
  left: RegimenDefinition,
  right: RegimenDefinition
): boolean {
  return regimenIdentity(left) === regimenIdentity(right);
}

export function classContains(
  catalog: DrugCatalog,
  classId: string,
  drugId: string
): boolean | "unknown" {
  const drugClass = catalog.classes.find(item => item.id === classId);
  if (!drugClass) return "unknown";
  return drugClass.memberDrugIds.includes(drugId);
}

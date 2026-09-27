import { z } from "zod";

export const pinnedDiseaseConceptSchema = z
  .object({
    ontologySystem: z.string().trim().min(1).max(40),
    ontologyVersion: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(80),
    ancestorCodes: z.array(z.string().trim().min(1).max(80)).optional(),
    hierarchyComplete: z.boolean().optional(),
  })
  .strict();

export type PinnedDiseaseConcept = z.infer<typeof pinnedDiseaseConceptSchema>;
export type PinnedDiseaseMatch =
  | "exact"
  | "broader"
  | "narrower"
  | "none"
  | "unknown";

function same(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * Match only version-pinned ontology concepts.
 *
 * Cross-version concepts and incomplete hierarchies remain unknown. A parent
 * relationship is never inferred from labels or token overlap.
 */
export function matchPinnedDisease(
  caseTumor: PinnedDiseaseConcept,
  evidenceTumor: PinnedDiseaseConcept
): PinnedDiseaseMatch {
  if (
    !same(caseTumor.ontologySystem, evidenceTumor.ontologySystem) ||
    caseTumor.ontologyVersion !== evidenceTumor.ontologyVersion
  ) {
    return "unknown";
  }
  if (same(caseTumor.code, evidenceTumor.code)) return "exact";

  if (
    caseTumor.ancestorCodes?.some(code => same(code, evidenceTumor.code))
  ) {
    return "broader";
  }
  if (
    evidenceTumor.ancestorCodes?.some(code => same(code, caseTumor.code))
  ) {
    return "narrower";
  }
  if (caseTumor.hierarchyComplete && evidenceTumor.hierarchyComplete) {
    return "none";
  }
  return "unknown";
}

export function evidenceDiseaseConcept(
  payload: Record<string, unknown>
): PinnedDiseaseConcept | null {
  const result = pinnedDiseaseConceptSchema.safeParse(
    payload.diseaseOntology ?? payload.evidenceDisease
  );
  return result.success ? result.data : null;
}


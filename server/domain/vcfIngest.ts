import { sql } from "drizzle-orm";
import { variants } from "../../drizzle/schema";

/**
 * Columns rewritten when the same case is submitted again.
 *
 * `variants_org_case_normalized_uq` keys a row by organization + case +
 * `normalizedId` (build:chrom:pos:ref:alt). A re-ingest of the same VCF used to
 * fail the unique constraint. These fields are the annotation that a new file
 * is allowed to refresh. Reviewer state (`reviewStatus`) and identity (`id`)
 * stay put so a re-upload cannot silently un-approve a variant.
 *
 * Triage is recomputed after the upsert, because AF / consequence / ClinVar
 * may have changed.
 */
export const variantReingestSet = {
  gene: sql`excluded."gene"`,
  transcript: sql`excluded."transcript"`,
  hgvsC: sql`excluded."hgvsC"`,
  hgvsP: sql`excluded."hgvsP"`,
  consequence: sql`excluded."consequence"`,
  variantType: sql`excluded."variantType"`,
  zygosity: sql`excluded."zygosity"`,
  populationAf: sql`excluded."populationAf"`,
  vaf: sql`excluded."vaf"`,
  readDepth: sql`excluded."readDepth"`,
  alternateDepth: sql`excluded."alternateDepth"`,
  impact: sql`excluded."impact"`,
  clinvarSignificance: sql`excluded."clinvarSignificance"`,
  annotation: sql`excluded."annotation"`,
  chromosome: sql`excluded."chromosome"`,
  position: sql`excluded."position"`,
  referenceAllele: sql`excluded."referenceAllele"`,
  alternateAllele: sql`excluded."alternateAllele"`,
  referenceBuild: sql`excluded."referenceBuild"`,
};

export const variantReingestTarget = [
  variants.organizationId,
  variants.caseId,
  variants.normalizedId,
] as const;

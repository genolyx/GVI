/** Shared batch that one-off "Run a single variant" jobs land in. */
export const SINGLE_VARIANTS_BATCH = "Single variants";

export function isSingleVariantBatch(name: string | null | undefined) {
  return name === SINGLE_VARIANTS_BATCH;
}

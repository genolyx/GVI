import type { Variant } from "../../../drizzle/schema";
import {
  normalizeIndelWithReference,
  type VerifiedIndelNormalization,
} from "./referenceFasta";

export type SomaticVariantAnalysis = {
  normalizationStatus: "normalized" | "failed";
  normalizationError: string | null;
  originalRepresentation: Record<string, unknown>;
  normalizedRepresentation: Record<string, unknown> | null;
  transcriptPolicy: string | null;
  qcStatus:
    | "pass"
    | "low_depth"
    | "low_vaf"
    | "filtered"
    | "manual_review_required"
    | "indeterminate";
  qcReasons: string[];
  candidate: boolean;
};

const MIN_DEPTH = 20;
const MIN_VAF = 0.02;

/**
 * Validate the VCF-ingested representation for Phase-1 somatic review.
 *
 * True repeat-aware left alignment requires the pinned reference FASTA and is
 * not fabricated here. Indels that cannot be proven normalized are explicitly
 * held for manual review rather than silently rewritten.
 */
export function analyzeSomaticVariant(
  variant: Variant,
  expectedBuild?: Variant["referenceBuild"],
  verifiedIndel?: VerifiedIndelNormalization | null
): SomaticVariantAnalysis {
  const originalRepresentation = {
    build: variant.referenceBuild,
    chromosome: variant.chromosome,
    position: variant.position,
    reference: variant.referenceAllele,
    alternate: variant.alternateAllele,
    gene: variant.gene,
    transcript: variant.transcript,
    hgvsC: variant.hgvsC,
    hgvsP: variant.hgvsP,
  };

  if (expectedBuild && variant.referenceBuild !== expectedBuild) {
    return {
      normalizationStatus: "failed",
      normalizationError: `Variant build ${variant.referenceBuild} does not match panel build ${expectedBuild}.`,
      originalRepresentation,
      normalizedRepresentation: null,
      transcriptPolicy: null,
      qcStatus: "manual_review_required",
      qcReasons: ["panel_build_mismatch"],
      candidate: false,
    };
  }

  if (variant.variantType !== "SNV" && variant.variantType !== "INDEL") {
    return {
      normalizationStatus: "failed",
      normalizationError: `Phase 1 supports SNV/INDEL only, not ${variant.variantType}.`,
      originalRepresentation,
      normalizedRepresentation: null,
      transcriptPolicy: null,
      qcStatus: "manual_review_required",
      qcReasons: ["unsupported_variant_type"],
      candidate: false,
    };
  }

  if (
    !variant.chromosome ||
    variant.position < 1 ||
    !variant.referenceAllele ||
    !variant.alternateAllele ||
    variant.referenceAllele === variant.alternateAllele
  ) {
    return {
      normalizationStatus: "failed",
      normalizationError:
        "The submitted locus is incomplete or has identical alleles.",
      originalRepresentation,
      normalizedRepresentation: null,
      transcriptPolicy: null,
      qcStatus: "manual_review_required",
      qcReasons: ["invalid_locus"],
      candidate: false,
    };
  }

  const reasons: string[] = [];
  let qcStatus: SomaticVariantAnalysis["qcStatus"] = "pass";
  if (variant.readDepth == null) {
    reasons.push("depth_missing");
    qcStatus = "indeterminate";
  } else if (variant.readDepth < MIN_DEPTH) {
    reasons.push(`depth_below_${MIN_DEPTH}`);
    qcStatus = "low_depth";
  }
  const vaf = variant.vaf == null ? null : Number(variant.vaf);
  if (vaf == null || !Number.isFinite(vaf)) {
    reasons.push("vaf_missing");
    if (qcStatus === "pass") qcStatus = "indeterminate";
  } else if (vaf < MIN_VAF) {
    reasons.push(`vaf_below_${MIN_VAF}`);
    qcStatus = "low_vaf";
  }

  const callFilter =
    variant.annotation && typeof variant.annotation.callFilter === "string"
      ? variant.annotation.callFilter
      : null;
  if (callFilter && callFilter !== "PASS" && callFilter !== ".") {
    reasons.push(`vcf_filter:${callFilter}`);
    qcStatus = "filtered";
  }
  if (variant.variantType === "INDEL") {
    if (!verifiedIndel) {
      reasons.push("reference_fasta_left_alignment_not_verified");
      if (qcStatus === "pass") qcStatus = "manual_review_required";
    }
  }

  const normalized =
    variant.variantType === "INDEL" && verifiedIndel
      ? {
          normalizedId: verifiedIndel.normalizedId,
          build: variant.referenceBuild,
          chromosome: verifiedIndel.chromosome,
          position: verifiedIndel.position,
          reference: verifiedIndel.reference,
          alternate: verifiedIndel.alternate,
          gene: variant.gene,
          transcript: variant.transcript,
          hgvsC: variant.hgvsC,
          hgvsP: variant.hgvsP,
          shiftedBases: verifiedIndel.shiftedBases,
          referenceProvenance: verifiedIndel.referenceProvenance,
        }
      : {
          normalizedId: variant.normalizedId,
          build: variant.referenceBuild,
          chromosome: variant.chromosome.replace(/^chr/i, ""),
          position: variant.position,
          reference: variant.referenceAllele.toUpperCase(),
          alternate: variant.alternateAllele.toUpperCase(),
          gene: variant.gene,
          transcript: variant.transcript,
          hgvsC: variant.hgvsC,
          hgvsP: variant.hgvsP,
        };

  return {
    normalizationStatus: "normalized",
    normalizationError: null,
    originalRepresentation,
    normalizedRepresentation: normalized,
    transcriptPolicy: variant.transcript ? "submitted_transcript" : null,
    qcStatus,
    qcReasons: reasons,
    candidate:
      qcStatus === "pass" &&
      (variant.impact === "HIGH" || variant.impact === "MODERATE"),
  };
}

export async function analyzeSomaticVariantWithReference(
  variant: Variant,
  expectedBuild?: Variant["referenceBuild"]
): Promise<SomaticVariantAnalysis> {
  if (variant.variantType !== "INDEL") {
    return analyzeSomaticVariant(variant, expectedBuild);
  }
  try {
    const normalized = await normalizeIndelWithReference(variant);
    return analyzeSomaticVariant(variant, expectedBuild, normalized);
  } catch (error) {
    const fallback = analyzeSomaticVariant(variant, expectedBuild);
    return {
      ...fallback,
      normalizationStatus: "failed",
      normalizationError:
        error instanceof Error
          ? error.message
          : "Reference FASTA normalization failed.",
      normalizedRepresentation: null,
      qcStatus: "manual_review_required",
      qcReasons: Array.from(
        new Set([
          ...fallback.qcReasons.filter(
            reason => reason !== "reference_fasta_left_alignment_not_verified"
          ),
          "reference_fasta_normalization_failed",
        ])
      ),
      candidate: false,
    };
  }
}

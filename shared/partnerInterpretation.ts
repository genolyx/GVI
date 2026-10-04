import { z } from "zod";
import { CURATION_CONTRACT_VERSION } from "./curation/document";
import { FREQUENCY_TRACKS, type FrequencyTrack } from "./germlineFrequency";
import { hasGeneScopeChoice } from "./geneScope";

/**
 * Portal interpretation jobs. Standalone GVC orders keep using
 * `frequencyTrackForOrder` and are not accepted or rejected here.
 *
 * Health screening and proactive panels have no frequency track yet, so they
 * do not become jobs. sgNIPT and PGx-only panels are outside this contract.
 * Dark-gene sections are not in this payload; carrier jobs record that the
 * block is deferred to a later contract.
 */

export const PARTNER_INTERPRETATION_CONTRACT_VERSION = "1" as const;

/** Bump when germline frequency rules change. Part of the idempotency key. */
export const GERMLINE_FILTER_CONTRACT_VERSION = "1" as const;

/** ACMG document contract used as the classification ruleset. */
export const PARTNER_CLASSIFICATION_RULESET = CURATION_CONTRACT_VERSION;

export const PARTNER_INTERPRETATION_JOBS_PATH =
  "/api/partner/v1/interpretation-jobs" as const;

export const PARTNER_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export type PartnerJobStatus = (typeof PARTNER_JOB_STATUSES)[number];

export const PARTNER_DECLINE_REASONS = [
  "invalid_request",
  "unknown_service",
  "sgnipt_out_of_scope",
  "pgx_only_out_of_scope",
  "health_screening_track_unset",
  "gene_scope_required",
  "track_mismatch",
] as const;

export type PartnerDeclineReason = (typeof PARTNER_DECLINE_REASONS)[number];

export const PARTNER_CANONICAL_SERVICES = [
  "carrier_screening",
  "whole_exome",
] as const;

export type PartnerCanonicalService =
  (typeof PARTNER_CANONICAL_SERVICES)[number];

export type PartnerClinicalTrack = Exclude<FrequencyTrack, "none">;

const SERVICE_ALIASES: Record<string, string> = {
  carrier: "carrier_screening",
  carrier_couples: "carrier_screening",
  carrier_screening: "carrier_screening",
  wes_panel: "whole_exome",
  whole_exome: "whole_exome",
  health_snp: "health_screening",
  health_screening: "health_screening",
  sgnipt: "sgnipt",
};

const sha256Schema = z
  .string()
  .trim()
  .regex(/^[a-fA-F0-9]{64}$/);

export const partnerInterpretationJobRequestSchema = z
  .object({
    contractVersion: z.literal(PARTNER_INTERPRETATION_CONTRACT_VERSION),
    externalOrderId: z.string().trim().min(1).max(64),
    serviceCode: z.string().trim().min(1).max(64),
    panelCategory: z.string().trim().max(64).optional(),
    packageCode: z.string().trim().max(80).optional(),
    otherTestType: z.string().trim().max(160).optional(),
    wesPanelId: z.string().trim().max(80).optional(),
    referenceBuild: z.enum(["GRCh37", "GRCh38"]),
    vcf: z
      .object({
        sha256: sha256Schema,
        uri: z.string().trim().min(1).max(2000),
      })
      .strict(),
    genes: z.string().max(200_000).default(""),
    hpo: z.string().max(4000).default(""),
    maxAf: z.number().min(0).max(1).nullable().default(null),
    expectedTrack: z.enum(FREQUENCY_TRACKS).optional(),
    callbackUrl: z.string().trim().url().max(2000).optional(),
  })
  .strict();

export type PartnerInterpretationJobRequest = z.infer<
  typeof partnerInterpretationJobRequestSchema
>;

export const partnerVariantSummarySchema = z
  .object({
    variantKey: z.string().min(1),
    chrom: z.string().min(1),
    pos: z.number().int().positive(),
    ref: z.string().min(1),
    alt: z.string().min(1),
    gene: z.string(),
    hgvsc: z.string().nullable(),
    transcript: z.string().nullable(),
    zygosity: z.string().nullable(),
    acmgClassification: z.string().nullable(),
    acmgCriteria: z.array(z.string()),
    heldReason: z.string().nullable(),
  })
  .strict();

export type PartnerVariantSummary = z.infer<typeof partnerVariantSummarySchema>;

export const partnerInterpretationJobSchema = z
  .object({
    contractVersion: z.literal(PARTNER_INTERPRETATION_CONTRACT_VERSION),
    filterContractVersion: z.literal(GERMLINE_FILTER_CONTRACT_VERSION),
    rulesetVersion: z.literal(PARTNER_CLASSIFICATION_RULESET),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(1),
    externalOrderId: z.string().min(1),
    status: z.enum(PARTNER_JOB_STATUSES),
    track: z.enum(["carrier", "rare_disease", "hereditary_cancer"]),
    canonicalService: z.enum(PARTNER_CANONICAL_SERVICES),
    darkGeneResult: z.enum(["deferred", "not_requested"]),
    referenceBuild: z.enum(["GRCh37", "GRCh38"]),
    vcfSha256: sha256Schema,
    databaseVersions: z.record(z.string(), z.string()),
    counts: z
      .object({
        kept: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    error: z.string().max(4000).optional(),
    vcfUpload: z
      .object({
        method: z.literal("PUT"),
        path: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PartnerInterpretationJob = z.infer<
  typeof partnerInterpretationJobSchema
>;

export type PartnerTrackDecision =
  | {
      accepted: true;
      track: PartnerClinicalTrack;
      canonicalService: PartnerCanonicalService;
      darkGeneResult: "deferred" | "not_requested";
    }
  | {
      accepted: false;
      reason: Exclude<
        PartnerDeclineReason,
        "invalid_request" | "gene_scope_required" | "track_mismatch"
      >;
    };

export type PartnerInterpretationResult =
  | {
      accepted: true;
      request: PartnerInterpretationJobRequest;
      track: PartnerClinicalTrack;
      canonicalService: PartnerCanonicalService;
      darkGeneResult: "deferred" | "not_requested";
      filterContractVersion: typeof GERMLINE_FILTER_CONTRACT_VERSION;
      rulesetVersion: typeof PARTNER_CLASSIFICATION_RULESET;
      idempotencyKey: string;
    }
  | {
      accepted: false;
      reason: PartnerDeclineReason;
      message?: string;
    };

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function canonicalPortalService(serviceCode: string): string | null {
  return SERVICE_ALIASES[text(serviceCode).toLowerCase()] ?? null;
}

/**
 * Map a portal order onto a GVC frequency track.
 * Panel category wins over the service code, matching the portal review tabs.
 */
export function resolvePartnerTrack(input: {
  serviceCode: string;
  panelCategory?: string | null;
  packageCode?: string | null;
  otherTestType?: string | null;
}): PartnerTrackDecision {
  const service = canonicalPortalService(input.serviceCode);
  const panel = text(input.panelCategory).toLowerCase();
  const packageCode = text(input.packageCode);
  const program = text(input.otherTestType) || packageCode;

  if (service === "sgnipt")
    return { accepted: false, reason: "sgnipt_out_of_scope" };
  if (panel === "pgx")
    return { accepted: false, reason: "pgx_only_out_of_scope" };
  if (panel === "proactive_health" || panel === "health_screening") {
    return { accepted: false, reason: "health_screening_track_unset" };
  }
  if (panel === "carrier_screening")
    return accept("carrier", "carrier_screening");
  if (
    panel === "hereditary_cancer" ||
    program === "HereditaryCancer" ||
    packageCode === "HereditaryCancer"
  ) {
    return accept(
      "hereditary_cancer",
      service === "carrier_screening" ? "carrier_screening" : "whole_exome"
    );
  }
  if (
    panel === "whole_exome" ||
    service === "whole_exome" ||
    packageCode === "WholeExome" ||
    program === "WGS" ||
    program.startsWith("Exome")
  ) {
    return accept("rare_disease", "whole_exome");
  }
  if (
    service === "health_screening" ||
    packageCode === "HealthScreening" ||
    packageCode === "Proactive" ||
    program === "Proactive"
  ) {
    return { accepted: false, reason: "health_screening_track_unset" };
  }
  if (
    service === "carrier_screening" ||
    packageCode === "CarrierScreening" ||
    packageCode === "CouplesCarrier" ||
    program === "CouplesCarrier"
  ) {
    return accept("carrier", "carrier_screening");
  }
  return { accepted: false, reason: "unknown_service" };
}

function accept(
  track: PartnerClinicalTrack,
  canonicalService: PartnerCanonicalService
): PartnerTrackDecision {
  return {
    accepted: true,
    track,
    canonicalService,
    darkGeneResult: track === "carrier" ? "deferred" : "not_requested",
  };
}

export function partnerInterpretationIdempotencyKey(input: {
  externalOrderId: string;
  vcfSha256: string;
  filterContractVersion?: string;
  rulesetVersion?: string;
}): string {
  return [
    input.externalOrderId.trim(),
    input.vcfSha256.trim().toLowerCase(),
    input.filterContractVersion ?? GERMLINE_FILTER_CONTRACT_VERSION,
    input.rulesetVersion ?? PARTNER_CLASSIFICATION_RULESET,
  ].join(":");
}

export function interpretPartnerJob(
  input: unknown
): PartnerInterpretationResult {
  const parsed = partnerInterpretationJobRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: "invalid_request",
      message: parsed.error.issues.map(issue => issue.message).join("; "),
    };
  }
  const request: PartnerInterpretationJobRequest = {
    ...parsed.data,
    vcf: { ...parsed.data.vcf, sha256: parsed.data.vcf.sha256.toLowerCase() },
  };
  const track = resolvePartnerTrack(request);
  if (!track.accepted) return track;
  if (!hasGeneScopeChoice({ genes: request.genes, hpo: request.hpo })) {
    return { accepted: false, reason: "gene_scope_required" };
  }
  if (request.expectedTrack && request.expectedTrack !== track.track) {
    return { accepted: false, reason: "track_mismatch" };
  }
  return {
    accepted: true,
    request,
    track: track.track,
    canonicalService: track.canonicalService,
    darkGeneResult: track.darkGeneResult,
    filterContractVersion: GERMLINE_FILTER_CONTRACT_VERSION,
    rulesetVersion: PARTNER_CLASSIFICATION_RULESET,
    idempotencyKey: partnerInterpretationIdempotencyKey({
      externalOrderId: request.externalOrderId,
      vcfSha256: request.vcf.sha256,
    }),
  };
}

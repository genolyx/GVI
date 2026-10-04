import { createHash } from "node:crypto";
import type { VcfFilterInput } from "./vcfSelection";
import { DEFAULT_MAX_ALLELE_FREQUENCY } from "@shared/germlineFrequency";
import {
  GERMLINE_FILTER_CONTRACT_VERSION,
  PARTNER_CLASSIFICATION_RULESET,
  PARTNER_INTERPRETATION_CONTRACT_VERSION,
  PARTNER_INTERPRETATION_JOBS_PATH,
  type PartnerClinicalTrack,
  type PartnerInterpretationJob,
  type PartnerInterpretationJobRequest,
  type PartnerJobStatus,
} from "@shared/partnerInterpretation";

export const PARTNER_ORG_SLUG = "gx-portal-partner";
export const PARTNER_USER_OPEN_ID = "gvi-partner-api";

export type PartnerJobManifest = {
  schemaVersion: "1.0";
  serviceCode: "gvi_partner_interpretation";
  partner: {
    contractVersion: typeof PARTNER_INTERPRETATION_CONTRACT_VERSION;
    idempotencyKey: string;
    externalOrderId: string;
    track: PartnerClinicalTrack;
    canonicalService: PartnerInterpretationJob["canonicalService"];
    darkGeneResult: PartnerInterpretationJob["darkGeneResult"];
    filterContractVersion: typeof GERMLINE_FILTER_CONTRACT_VERSION;
    rulesetVersion: typeof PARTNER_CLASSIFICATION_RULESET;
    referenceBuild: "GRCh37" | "GRCh38";
    vcfSha256: string;
    vcfUri: string;
    awaitingVcf: boolean;
    genes: string;
    hpo: string;
    maxAf: number | null;
  };
  vcfFilters: VcfFilterInput;
};

/** Column-sized id. The public idempotency key is longer than analysis_jobs.idempotencyKey. */
export function partnerJobStorageKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

export function partnerJobLookupId(idOrKey: string): string {
  const value = idOrKey.trim();
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  return partnerJobStorageKey(value);
}

export function partnerVcfUploadPath(id: string): string {
  return `${PARTNER_INTERPRETATION_JOBS_PATH}/${id}/vcf`;
}

export function partnerVcfFilters(input: {
  genes: string;
  hpo: string;
  maxAf: number | null;
  track: PartnerClinicalTrack;
}): VcfFilterInput {
  return {
    hpo: input.hpo,
    genes: input.genes,
    maxAf: input.maxAf ?? DEFAULT_MAX_ALLELE_FREQUENCY,
    minQual: null,
    minGenotypeQuality: null,
    minDepth: null,
    passOnly: true,
    codingOnly: false,
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
    track: input.track,
  };
}

export function partnerJobManifest(
  request: PartnerInterpretationJobRequest,
  decision: {
    track: PartnerClinicalTrack;
    canonicalService: PartnerInterpretationJob["canonicalService"];
    darkGeneResult: PartnerInterpretationJob["darkGeneResult"];
    idempotencyKey: string;
  }
): PartnerJobManifest {
  return {
    schemaVersion: "1.0",
    serviceCode: "gvi_partner_interpretation",
    partner: {
      contractVersion: PARTNER_INTERPRETATION_CONTRACT_VERSION,
      idempotencyKey: decision.idempotencyKey,
      externalOrderId: request.externalOrderId,
      track: decision.track,
      canonicalService: decision.canonicalService,
      darkGeneResult: decision.darkGeneResult,
      filterContractVersion: GERMLINE_FILTER_CONTRACT_VERSION,
      rulesetVersion: PARTNER_CLASSIFICATION_RULESET,
      referenceBuild: request.referenceBuild,
      vcfSha256: request.vcf.sha256,
      vcfUri: request.vcf.uri,
      awaitingVcf: true,
      genes: request.genes,
      hpo: request.hpo,
      maxAf: request.maxAf,
    },
    vcfFilters: partnerVcfFilters({
      genes: request.genes,
      hpo: request.hpo,
      maxAf: request.maxAf,
      track: decision.track,
    }),
  };
}

export function readPartnerManifest(value: unknown): PartnerJobManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PartnerJobManifest>;
  if (record.serviceCode !== "gvi_partner_interpretation" || !record.partner)
    return null;
  return record as PartnerJobManifest;
}

export function partnerStatusFromParts(input: {
  analysisStatus: string;
  awaitingVcf: boolean;
  activeRuns: number;
  failedRuns: number;
  succeededRuns: number;
}): PartnerJobStatus {
  if (input.awaitingVcf) return "queued";
  if (input.analysisStatus === "failed") return "failed";
  if (input.analysisStatus === "queued") return "queued";
  if (input.analysisStatus === "running") return "running";
  if (input.activeRuns > 0) return "running";
  if (input.succeededRuns > 0) return "succeeded";
  if (input.failedRuns > 0) return "failed";
  return "succeeded";
}

export function vcfFileName(uri: string): string {
  const path = uri.split("?")[0] ?? uri;
  const base = path.split("/").pop() || "input.vcf";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  if (!clean || clean === "." || clean === "..") return "input.vcf";
  return clean;
}

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { cases } from "../../drizzle/schema";
import type { VcfFilterInput } from "./vcfSelection";
import { DEFAULT_MAX_ALLELE_FREQUENCY } from "@shared/germlineFrequency";
import { hasGeneScopeChoice } from "@shared/geneScope";
import type { PartnerDarkGenes } from "@shared/darkGenes";
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
    darkGenes?: PartnerDarkGenes;
    filterContractVersion: typeof GERMLINE_FILTER_CONTRACT_VERSION;
    rulesetVersion: typeof PARTNER_CLASSIFICATION_RULESET;
    referenceBuild: "GRCh37" | "GRCh38";
    vcfSha256: string;
    vcfUri: string;
    awaitingVcf: boolean;
    genes: string;
    hpo: string;
    maxAf: number | null;
    includePgx?: boolean;
    includeApoePgx?: boolean;
    panelCode?: string;
    panelName?: string;
    /** Set after the case classifier has been asked to queue this order. */
    classificationQueued?: boolean;
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
  minQual?: number | null;
  minGenotypeQuality?: number | null;
  minDepth?: number | null;
  passOnly?: boolean | null;
}): VcfFilterInput {
  return {
    hpo: input.hpo,
    genes: input.genes,
    maxAf: input.maxAf ?? DEFAULT_MAX_ALLELE_FREQUENCY,
    minQual: input.minQual ?? null,
    minGenotypeQuality: input.minGenotypeQuality ?? null,
    minDepth: input.minDepth ?? null,
    passOnly: input.passOnly !== false,
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
      includePgx: request.includePgx,
      includeApoePgx: request.includeApoePgx,
      ...(request.panelCode ? { panelCode: request.panelCode, panelName: request.panelName } : {}),
    },
    vcfFilters: partnerVcfFilters({
      genes: request.genes,
      hpo: request.hpo,
      maxAf: request.maxAf,
      track: decision.track,
      minQual: request.minQual,
      minGenotypeQuality: request.minGenotypeQuality,
      minDepth: request.minDepth,
      passOnly: request.passOnly,
    }),
  };
}

/** Whole-exome VCF-only jobs are accepted with an empty gene list. Ingest must not ask for a panel. */
export function partnerSkipsGeneScope(manifest: PartnerJobManifest | null): boolean {
  if (!manifest) return false;
  return !hasGeneScopeChoice({
    genes: manifest.partner.genes,
    hpo: manifest.partner.hpo,
  });
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

/**
 * A later Portal submission for the same order reuses that case.
 * A signed case stays as it is. An identical request only reopens a failure.
 */
export function samePartnerOrderAction(input: {
  storedIdempotencyKey: string;
  incomingIdempotencyKey: string;
  jobStatus: string;
  caseStatus: string;
}): "return" | "reopen" | "replace" | "keep" {
  if (input.caseStatus === "in_review" || input.caseStatus === "reported") return "keep";
  if (input.storedIdempotencyKey === input.incomingIdempotencyKey) {
    return input.jobStatus === "failed" ? "reopen" : "return";
  }
  return "replace";
}

/** Portal case numbers are hashes. One order keeps the latest case on screen. */
export function currentPartnerOrderCondition(organizationId: number) {
  return sql`(
    ${cases.caseNumber} !~ '^[a-f0-9]{64}$'
    OR ${cases.id} IN (
      SELECT DISTINCT ON (current_case."patientAlias") current_case.id
      FROM cases current_case
      WHERE current_case."organizationId" = ${organizationId}
        AND current_case."caseNumber" ~ '^[a-f0-9]{64}$'
      ORDER BY current_case."patientAlias", current_case."updatedAt" DESC, current_case.id DESC
    )
  )`;
}

export function vcfFileName(uri: string): string {
  const path = uri.split("?")[0] ?? uri;
  const base = path.split("/").pop() || "input.vcf";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  if (!clean || clean === "." || clean === "..") return "input.vcf";
  return clean;
}

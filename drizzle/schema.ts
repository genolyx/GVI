import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { CurationSummary } from "../shared/curation/document";
import type { NormalizedVariantContext } from "../server/domain/somatic/civic/types";

/** Engine request recorded on `curation_runs.input`. */
export type CurationRunInput = {
  gene: string;
  hgvsC: string;
  transcript?: string | null;
  hgvsP?: string | null;
  clinicalNotes?: string | null;
  referenceBuild: "GRCh37" | "GRCh38";
  /** Build the VCF / case was submitted on, when different from `referenceBuild`. */
  submittedBuild?: "GRCh37" | "GRCh38" | null;
  liftedLocus?: {
    chromosome: string;
    position: number;
    source: "ensembl_map";
    from: { build: "GRCh37"; chromosome: string; position: number };
  } | null;
  liftError?: string | null;
  runLiterature: boolean;
  /** Sample / DNA id from the workbench intake form. */
  labId?: string | null;
  /** Free-text case identifier, not the numeric `cases.id`. */
  externalCaseId?: string | null;
  pmids?: string | null;
};

/** Failure recorded on `curation_runs.error`. */
export type CurationRunError = {
  kind: string;
  message: string;
  attempt: number;
  at: string;
};

/**
 * Column helpers.
 *
 * Postgres has no `ON UPDATE CURRENT_TIMESTAMP`, so `updatedAt` is maintained in two
 * layers: `$onUpdate` covers every Drizzle-issued update, and a `set_updated_at`
 * trigger (see the 0000 migration) covers raw SQL that bypasses the ORM.
 */
const createdAt = () =>
  timestamp("createdAt", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updatedAt", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
const surrogateId = () =>
  integer("id").primaryKey().generatedAlwaysAsIdentity();

// ── Enum types ─────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", [
  "user",
  "admin",
  "super_admin",
]);
export const organizationStatusEnum = pgEnum("organization_status", [
  "active",
  "suspended",
]);
export const isolationModeEnum = pgEnum("isolation_mode", [
  "shared_schema",
  "dedicated_database",
]);
export const organizationRoleEnum = pgEnum("organization_role", [
  "administrator",
  "analyst",
  "clinician",
  "viewer",
]);
export const membershipStatusEnum = pgEnum("membership_status", [
  "invited",
  "active",
  "suspended",
]);
export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "archived",
]);
export const casePurposeEnum = pgEnum("case_purpose", ["germline", "somatic"]);
export const caseInputTypeEnum = pgEnum("case_input_type", ["vcf", "fastq"]);
export const caseStatusEnum = pgEnum("case_status", [
  "draft",
  "queued",
  "running",
  "review_ready",
  "in_review",
  "reported",
  "failed",
]);
export const referenceBuildEnum = pgEnum("reference_build", [
  "GRCh37",
  "GRCh38",
]);
export const sampleRoleEnum = pgEnum("sample_role", [
  "proband",
  "mother",
  "father",
  "tumor",
  "normal",
  "other",
]);
export const caseFileKindEnum = pgEnum("case_file_kind", [
  "vcf",
  "fastq_r1",
  "fastq_r2",
  "bam",
  "bai",
  "report",
  "panel_bed",
  "coverage",
  "assay_result",
  "annotated_vcf",
  "other",
]);
export const caseFileStatusEnum = pgEnum("case_file_status", [
  "uploaded",
  "verified",
  "rejected",
]);
export const analysisPipelineEnum = pgEnum("analysis_pipeline", [
  "vcf_ingest",
  "gx_exome",
  "gx_somatic",
]);
export const analysisJobStatusEnum = pgEnum("analysis_job_status", [
  "queued",
  "running",
  "review_ready",
  "failed",
  "completed",
]);
export const variantTypeEnum = pgEnum("variant_type", [
  "SNV",
  "INDEL",
  "CNV",
  "SV",
  "FUSION",
  "OTHER",
]);
export const variantImpactEnum = pgEnum("variant_impact", [
  "HIGH",
  "MODERATE",
  "LOW",
  "MODIFIER",
  "UNKNOWN",
]);
export const variantReviewStatusEnum = pgEnum("variant_review_status", [
  "unreviewed",
  "reviewing",
  "reviewed",
  "flagged",
]);
export const evidenceSourceEnum = pgEnum("evidence_source", [
  "ClinVar",
  "OMIM",
  "gnomAD",
  "PubMed",
  "CIViC",
  "OncoKB",
  // Sources the SAM-VC curation engine draws on.
  "HGMD",
  "ClinGen",
  "SpliceAI",
  "Pangolin",
  "MetaDome",
  "UniProt",
  "Ensembl",
  "Internal",
  "Other",
]);
/**
 * Who produced a criterion or evidence row.
 *
 * The engine has no user account, so provenance cannot be inferred from
 * `updatedBy`. Inventing a system user would pollute the audit trail with actions
 * no person took, so the origin is recorded explicitly instead. `human_confirmed`
 * is an engine suggestion a reviewer accepted, which is the state that matters
 * when a report is signed.
 */
export const evidenceOriginEnum = pgEnum("evidence_origin", [
  "engine",
  "human",
  "human_confirmed",
]);
export const evidenceClinicalDomainEnum = pgEnum("evidence_clinical_domain", [
  "germline_classification",
  "oncogenicity",
  "therapeutic",
  "diagnostic",
  "prognostic",
  "population",
  "functional",
  "other",
]);
export const evidenceDirectionEnum = pgEnum("evidence_direction", [
  "supporting",
  "contradicting",
  "neutral",
]);
export const interpretationModeEnum = pgEnum("interpretation_mode", [
  "germline",
  "somatic",
]);
export const germlineClassificationEnum = pgEnum("germline_classification", [
  "Pathogenic",
  "Likely Pathogenic",
  "VUS",
  "Likely Benign",
  "Benign",
]);
export const somaticTierEnum = pgEnum("somatic_tier", [
  "Tier I",
  "Tier II",
  "Tier III",
  "Tier IV",
]);
export const oncogenicityEnum = pgEnum("oncogenicity_classification", [
  "Oncogenic",
  "Likely Oncogenic",
  "VUS",
  "Likely Benign",
  "Benign",
  "Not Evaluated",
]);
export const interpretationStatusEnum = pgEnum("interpretation_status", [
  "draft",
  "in_review",
  "approved",
]);
export const criterionStateEnum = pgEnum("criterion_state", [
  "met",
  "not_met",
  "not_applicable",
]);
/**
 * Triage outcome for a variant.
 *
 * `t1_curate` is queued for the engine, `t2_review` is held for a human to look at
 * before spending engine time, and `t3_filtered` is parked. Filtering is never
 * deletion — a reviewer can always promote a t3 variant.
 */
export const variantTriageTierEnum = pgEnum("variant_triage_tier", [
  "t1_curate",
  "t2_review",
  "t3_filtered",
]);
export const curationRunStatusEnum = pgEnum("curation_run_status", [
  "queued",
  "loading",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const aiMessageRoleEnum = pgEnum("ai_message_role", [
  "user",
  "assistant",
]);
export const reportStatusEnum = pgEnum("report_status", [
  "draft",
  "in_review",
  "signed",
  "amended",
]);
export const somaticRunStatusEnum = pgEnum("somatic_run_status", [
  "queued",
  "validating",
  "normalizing",
  "annotating",
  "ready_for_review",
  "partial",
  "failed",
]);
export const somaticNormalizationStatusEnum = pgEnum(
  "somatic_normalization_status",
  ["pending", "normalized", "failed"]
);
export const somaticQcStatusEnum = pgEnum("somatic_qc_status", [
  "pass",
  "low_depth",
  "low_vaf",
  "filtered",
  "manual_review_required",
  "indeterminate",
]);
export const diseaseMatchEnum = pgEnum("disease_match", [
  "exact",
  "broader",
  "narrower",
  "manual",
  "none",
  "unknown",
]);
export const somaticClinicalEffectEnum = pgEnum("somatic_clinical_effect", [
  "sensitivity",
  "resistance",
  "no_response",
  "unknown",
]);
export const ampLevelEnum = pgEnum("amp_level", ["A", "B", "C", "D"]);
export const somaticAssertionStatusEnum = pgEnum("somatic_assertion_status", [
  "proposed",
  "in_review",
  "approved",
  "rejected",
  "superseded",
]);
export const somaticReportTemplateStatusEnum = pgEnum(
  "somatic_report_template_status",
  ["draft", "published", "retired"]
);
export const somaticLifecycleStatusEnum = pgEnum("somatic_lifecycle_status", [
  "draft",
  "active",
  "retired",
]);
export const somaticValidationStatusEnum = pgEnum("somatic_validation_status", [
  "pending",
  "passed",
  "failed",
]);
export const somaticLicenseStatusEnum = pgEnum("somatic_license_status", [
  "unconfigured",
  "approved",
  "restricted",
  "expired",
]);
export const somaticRegionTypeEnum = pgEnum("somatic_region_type", [
  "gene",
  "exon",
  "interval",
  "fusion_pair",
  "signature",
]);
export const somaticFindingTypeEnum = pgEnum("somatic_finding_type", [
  "CNV",
  "FUSION",
  "MSI",
  "TMB",
  "HRD",
]);
export const somaticFindingStatusEnum = pgEnum("somatic_finding_status", [
  "detected",
  "not_detected",
  "not_tested",
  "indeterminate",
]);
export const somaticTaskStatusEnum = pgEnum("somatic_task_status", [
  "open",
  "in_review",
  "completed",
  "dismissed",
]);
export const somaticCivicImportStatusEnum = pgEnum(
  "somatic_civic_import_status",
  ["queued", "running", "partial", "complete", "failed", "cancelled"]
);
export const somaticCivicCheckpointStatusEnum = pgEnum(
  "somatic_civic_checkpoint_status",
  ["started", "complete", "partial", "failed"]
);

// ── Identity ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: surrogateId(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: userRoleEnum("role").default("user").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: surrogateId(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: organizationStatusEnum("status").default("active").notNull(),
    dataRegion: varchar("dataRegion", { length: 32 }).default("KR").notNull(),
    isolationMode: isolationModeEnum("isolationMode")
      .default("shared_schema")
      .notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [uniqueIndex("organizations_slug_uq").on(table.slug)]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    userId: integer("userId")
      .notNull()
      .references(() => users.id),
    role: organizationRoleEnum("role").notNull(),
    status: membershipStatusEnum("status").default("active").notNull(),
    invitedBy: integer("invitedBy").references(() => users.id),
    joinedAt: timestamp("joinedAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("organization_members_org_user_uq").on(
      table.organizationId,
      table.userId
    ),
    index("organization_members_user_idx").on(table.userId, table.status),
  ]
);

export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    email: varchar("email", { length: 320 }).notNull(),
    role: organizationRoleEnum("role").notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("acceptedAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  table => [
    uniqueIndex("organization_invites_token_uq").on(table.tokenHash),
    index("organization_invites_org_email_idx").on(
      table.organizationId,
      table.email
    ),
  ]
);

// ── Clinical structure ─────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    name: varchar("name", { length: 160 }).notNull(),
    code: varchar("code", { length: 40 }).notNull(),
    description: text("description"),
    status: projectStatusEnum("status").default("active").notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("projects_org_code_uq").on(table.organizationId, table.code),
    // Composite-FK targets must be UNIQUE constraints, not merely unique indexes.
    unique("projects_id_org_uq").on(table.id, table.organizationId),
    index("projects_org_status_idx").on(table.organizationId, table.status),
  ]
);

// ── Somatic reference masters ─────────────────────────────────────────────────

/**
 * Version-pinned disease concepts used only by the somatic workflow.
 *
 * Parentage is navigational metadata, never permission to inherit evidence. Each
 * clinical assertion records its explicit disease match separately.
 */
export const somaticTumorTypes = pgTable(
  "somatic_tumor_types",
  {
    id: surrogateId(),
    ontologySystem: varchar("ontologySystem", { length: 40 }).notNull(),
    ontologyVersion: varchar("ontologyVersion", { length: 80 }).notNull(),
    code: varchar("code", { length: 80 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    primarySite: varchar("primarySite", { length: 160 }),
    histology: varchar("histology", { length: 160 }),
    parentId: integer("parentId"),
    active: boolean("active").default(true).notNull(),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_tumor_types_system_version_code_uq").on(
      table.ontologySystem,
      table.ontologyVersion,
      table.code
    ),
    foreignKey({
      name: "somatic_tumor_types_parent_fk",
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
  ]
);

export const somaticPanels = pgTable(
  "somatic_panels",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    manufacturer: varchar("manufacturer", { length: 160 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_panels_id_org_uq").on(table.id, table.organizationId),
    unique("somatic_panels_org_manufacturer_name_uq").on(
      table.organizationId,
      table.manufacturer,
      table.name
    ),
  ]
);

export const somaticPanelVersions = pgTable(
  "somatic_panel_versions",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    panelId: integer("panelId").notNull(),
    version: varchar("version", { length: 80 }).notNull(),
    genomeBuild: referenceBuildEnum("genomeBuild").notNull(),
    assayType: varchar("assayType", { length: 120 }).notNull(),
    capabilities: jsonb("capabilities")
      .$type<{
        snvIndel: boolean;
        cnv: boolean;
        fusion: boolean;
        msi: boolean;
        tmb: boolean;
        hrd: boolean;
      }>()
      .notNull(),
    limitations: text("limitations"),
    regionArtifactName: varchar("regionArtifactName", { length: 255 }),
    regionArtifactHash: varchar("regionArtifactHash", { length: 64 }),
    regionValidationStatus: somaticValidationStatusEnum(
      "regionValidationStatus"
    )
      .default("pending")
      .notNull(),
    regionValidatedBy: integer("regionValidatedBy").references(() => users.id),
    regionValidatedAt: timestamp("regionValidatedAt", {
      withTimezone: true,
    }),
    activeFrom: timestamp("activeFrom", { withTimezone: true }),
    activeTo: timestamp("activeTo", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_panel_versions_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_panel_versions_panel_version_uq").on(
      table.organizationId,
      table.panelId,
      table.version
    ),
    foreignKey({
      name: "somatic_panel_versions_panel_org_fk",
      columns: [table.panelId, table.organizationId],
      foreignColumns: [somaticPanels.id, somaticPanels.organizationId],
    }).onDelete("restrict"),
    check(
      "somatic_panel_versions_region_validation_ck",
      sql`${table.regionValidationStatus} <> 'passed' OR (${table.regionArtifactHash} ~ '^[0-9a-f]{64}$' AND ${table.regionValidatedBy} IS NOT NULL AND ${table.regionValidatedAt} IS NOT NULL)`
    ),
  ]
);

export const cases = pgTable(
  "cases",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    projectId: integer("projectId").notNull(),
    caseNumber: varchar("caseNumber", { length: 64 }).notNull(),
    patientAlias: varchar("patientAlias", { length: 120 }).notNull(),
    purpose: casePurposeEnum("purpose").notNull(),
    inputType: caseInputTypeEnum("inputType").notNull(),
    status: caseStatusEnum("status").default("draft").notNull(),
    referenceBuild: referenceBuildEnum("referenceBuild").notNull(),
    panelName: varchar("panelName", { length: 160 }),
    indication: text("indication"),
    phenotypeText: text("phenotypeText"),
    consentClinicalAnalysis: boolean("consentClinicalAnalysis").notNull(),
    consentSecondaryFindings: boolean("consentSecondaryFindings")
      .default(false)
      .notNull(),
    consentDataUse: boolean("consentDataUse").default(false).notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("cases_org_number_uq").on(
      table.organizationId,
      table.caseNumber
    ),
    unique("cases_id_org_uq").on(table.id, table.organizationId),
    index("cases_org_status_idx").on(table.organizationId, table.status),
    index("cases_project_idx").on(table.organizationId, table.projectId),
    foreignKey({
      name: "cases_project_org_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("restrict"),
  ]
);

export type GermlinePanelRegion = {
  chromosome: string;
  start: number;
  end: number;
  name: string | null;
};

/** Reusable germline interpretation scope. Sequencing BED/BAM files are not stored here. */
export const germlinePanels = pgTable(
  "germline_panels",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    genes: jsonb("genes").$type<string[]>().notNull(),
    regions: jsonb("regions").$type<GermlinePanelRegion[]>(),
    genomeBuild: referenceBuildEnum("genomeBuild"),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("germline_panels_id_org_uq").on(table.id, table.organizationId),
    unique("germline_panels_org_code_uq").on(table.organizationId, table.code),
  ]
);

/** Frozen panel scope for one germline VCF case. */
export const germlineCasePanels = pgTable(
  "germline_case_panels",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    panelId: integer("panelId"),
    name: varchar("name", { length: 200 }).notNull(),
    genes: jsonb("genes").$type<string[]>().notNull(),
    regions: jsonb("regions").$type<GermlinePanelRegion[]>(),
    genomeBuild: referenceBuildEnum("genomeBuild"),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  table => [
    unique("germline_case_panels_case_uq").on(table.organizationId, table.caseId),
    foreignKey({
      name: "germline_case_panels_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "germline_case_panels_panel_org_fk",
      columns: [table.panelId, table.organizationId],
      foreignColumns: [germlinePanels.id, germlinePanels.organizationId],
    }).onDelete("restrict"),
  ]
);

/** Clinical order fields for a germline case. Sequencing paths are not stored here. */
export const germlineOrderDetails = pgTable(
  "germline_order_details",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    testCategory: varchar("testCategory", { length: 40 }).notNull(),
    otherTestType: varchar("otherTestType", { length: 160 }),
    packageCode: varchar("packageCode", { length: 80 }),
    reportMode: varchar("reportMode", { length: 20 }).notNull(),
    partnerCaseNumber: varchar("partnerCaseNumber", { length: 64 }),
    priorCaseNumber: varchar("priorCaseNumber", { length: 64 }),
    patientName: varchar("patientName", { length: 160 }),
    patientBirth: varchar("patientBirth", { length: 10 }),
    patientGender: varchar("patientGender", { length: 40 }),
    patient2Name: varchar("patient2Name", { length: 160 }),
    patient2Birth: varchar("patient2Birth", { length: 10 }),
    patient2Gender: varchar("patient2Gender", { length: 40 }),
    patient2Affected: varchar("patient2Affected", { length: 8 }),
    patient3Name: varchar("patient3Name", { length: 160 }),
    patient3Birth: varchar("patient3Birth", { length: 10 }),
    patient3Gender: varchar("patient3Gender", { length: 40 }),
    patient3Affected: varchar("patient3Affected", { length: 8 }),
    hospitalName: varchar("hospitalName", { length: 200 }),
    doctor: varchar("doctor", { length: 160 }),
    medicalRecordId: varchar("medicalRecordId", { length: 80 }),
    sampleId: varchar("sampleId", { length: 80 }),
    affected: varchar("affected", { length: 8 }),
    clinicalInformation: text("clinicalInformation"),
    sampleCollectionDate: varchar("sampleCollectionDate", { length: 10 }),
    receiptDate: varchar("receiptDate", { length: 10 }),
    reportLanguage: varchar("reportLanguage", { length: 16 }),
    reportType: varchar("reportType", { length: 40 }),
    specimenType: varchar("specimenType", { length: 40 }),
    sampleBarcode: varchar("sampleBarcode", { length: 80 }),
    updatedBy: integer("updatedBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("germline_order_details_case_uq").on(
      table.organizationId,
      table.caseId
    ),
    foreignKey({
      name: "germline_order_details_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export type GermlinePgxGene = {
  gene: string;
  source: string;
  diplotype: string;
  phenotype: string;
  alleleFunctions: string;
  category: "" | "actionable" | "normal";
  include: boolean;
};

export type GermlinePgxExtended = {
  gene: string;
  rsid: string;
  variantName: string;
  genotype: string;
  zygosity: string;
  significance: string;
  drugs: string;
  evidenceLevel: string;
  include: boolean;
};

/** Reviewer, patient, selected variants, and PGx calls for one germline case. */
export const germlineCaseReviews = pgTable(
  "germline_case_reviews",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    reviewerName: varchar("reviewerName", { length: 160 }),
    reviewerCode: varchar("reviewerCode", { length: 80 }),
    institution: varchar("institution", { length: 200 }),
    patientName: varchar("patientName", { length: 160 }),
    patientDob: varchar("patientDob", { length: 10 }),
    patientGender: varchar("patientGender", { length: 40 }),
    partnerName: varchar("partnerName", { length: 160 }),
    languages: jsonb("languages").$type<string[]>().notNull(),
    selectedVariantIds: jsonb("selectedVariantIds").$type<number[]>(),
    pgxGenes: jsonb("pgxGenes").$type<GermlinePgxGene[]>().notNull(),
    pgxExtended: jsonb("pgxExtended").$type<GermlinePgxExtended[]>().notNull(),
    updatedBy: integer("updatedBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("germline_case_reviews_case_uq").on(table.organizationId, table.caseId),
    foreignKey({
      name: "germline_case_reviews_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

/** Organization gene text used by the Gene database tab. Shared across cases. */
export const germlineGeneKnowledge = pgTable(
  "germline_gene_knowledge",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    gene: varchar("gene", { length: 80 }).notNull(),
    language: varchar("language", { length: 8 }).notNull(),
    disorder: text("disorder"),
    omimNumber: varchar("omimNumber", { length: 40 }),
    inheritance: varchar("inheritance", { length: 80 }),
    functionSummary: text("functionSummary"),
    diseaseAssociation: text("diseaseAssociation"),
    updatedBy: integer("updatedBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("germline_gene_knowledge_org_gene_lang_uq").on(
      table.organizationId,
      table.gene,
      table.language
    ),
  ]
);

export const samples = pgTable(
  "samples",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    sampleCode: varchar("sampleCode", { length: 80 }).notNull(),
    role: sampleRoleEnum("role").notNull(),
    specimenType: varchar("specimenType", { length: 100 }).notNull(),
    tumorContentPercent: numeric("tumorContentPercent", {
      precision: 5,
      scale: 2,
    }),
    collectedAt: timestamp("collectedAt", { withTimezone: true }),
    createdAt: createdAt(),
  },
  table => [
    uniqueIndex("samples_org_case_code_uq").on(
      table.organizationId,
      table.caseId,
      table.sampleCode
    ),
    unique("samples_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "samples_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

/**
 * One-to-one somatic-only clinical context. Germline cases never receive a row.
 */
export const somaticCaseContexts = pgTable(
  "somatic_case_contexts",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    primaryTumorTypeId: integer("primaryTumorTypeId").notNull(),
    panelVersionId: integer("panelVersionId").notNull(),
    histologyText: varchar("histologyText", { length: 255 }),
    diseaseStatus: varchar("diseaseStatus", { length: 80 }),
    specimenCollectionSite: varchar("specimenCollectionSite", {
      length: 160,
    }).notNull(),
    pairedNormal: boolean("pairedNormal").default(false).notNull(),
    mappingProvenance:
      jsonb("mappingProvenance").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_case_contexts_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_case_contexts_case_uq").on(
      table.organizationId,
      table.caseId
    ),
    foreignKey({
      name: "somatic_case_contexts_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_case_contexts_tumor_type_fk",
      columns: [table.primaryTumorTypeId],
      foreignColumns: [somaticTumorTypes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_case_contexts_panel_version_org_fk",
      columns: [table.panelVersionId, table.organizationId],
      foreignColumns: [
        somaticPanelVersions.id,
        somaticPanelVersions.organizationId,
      ],
    }).onDelete("restrict"),
  ]
);

export const caseFiles = pgTable(
  "case_files",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    sampleId: integer("sampleId"),
    kind: caseFileKindEnum("kind").notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    storageUrl: varchar("storageUrl", { length: 768 }).notNull(),
    mimeType: varchar("mimeType", { length: 160 }).notNull(),
    byteSize: bigint("byteSize", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    status: caseFileStatusEnum("status").default("uploaded").notNull(),
    uploadedBy: integer("uploadedBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  table => [
    unique("case_files_id_org_case_uq").on(
      table.id,
      table.organizationId,
      table.caseId
    ),
    uniqueIndex("case_files_org_storage_uq").on(
      table.organizationId,
      table.storageKey
    ),
    index("case_files_case_idx").on(table.organizationId, table.caseId),
    foreignKey({
      name: "case_files_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "case_files_sample_org_fk",
      columns: [table.sampleId, table.organizationId],
      foreignColumns: [samples.id, samples.organizationId],
    }).onDelete("restrict"),
  ]
);

// ── Case-level analysis pipeline ───────────────────────────────────────────────

export const analysisJobs = pgTable(
  "analysis_jobs",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    pipeline: analysisPipelineEnum("pipeline").notNull(),
    status: analysisJobStatusEnum("status").default("queued").notNull(),
    progressPercent: integer("progressPercent").default(0).notNull(),
    externalJobId: varchar("externalJobId", { length: 160 }),
    idempotencyKey: varchar("idempotencyKey", { length: 80 }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    errorMessage: text("errorMessage"),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    claimedAt: timestamp("claimedAt", { withTimezone: true }),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("analysis_jobs_idempotency_uq").on(table.idempotencyKey),
    unique("analysis_jobs_id_org_uq").on(table.id, table.organizationId),
    index("analysis_jobs_org_status_idx").on(
      table.organizationId,
      table.status
    ),
    foreignKey({
      name: "analysis_jobs_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export const analysisEvents = pgTable(
  "analysis_events",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    jobId: integer("jobId").notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    message: text("message").notNull(),
    progressPercent: integer("progressPercent").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  table => [
    index("analysis_events_job_idx").on(
      table.organizationId,
      table.jobId,
      table.createdAt
    ),
    foreignKey({
      name: "analysis_events_job_org_fk",
      columns: [table.jobId, table.organizationId],
      foreignColumns: [analysisJobs.id, analysisJobs.organizationId],
    }).onDelete("cascade"),
  ]
);

// ── Variants and interpretation ────────────────────────────────────────────────

export const variants = pgTable(
  "variants",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    normalizedId: varchar("normalizedId", { length: 255 }).notNull(),
    referenceBuild: referenceBuildEnum("referenceBuild").notNull(),
    chromosome: varchar("chromosome", { length: 16 }).notNull(),
    position: integer("position").notNull(),
    referenceAllele: text("referenceAllele").notNull(),
    alternateAllele: text("alternateAllele").notNull(),
    gene: varchar("gene", { length: 80 }),
    transcript: varchar("transcript", { length: 120 }),
    hgvsC: varchar("hgvsC", { length: 255 }),
    hgvsP: varchar("hgvsP", { length: 255 }),
    consequence: varchar("consequence", { length: 160 }),
    variantType: variantTypeEnum("variantType").notNull(),
    zygosity: varchar("zygosity", { length: 40 }),
    populationAf: numeric("populationAf", { precision: 12, scale: 10 }),
    vaf: numeric("vaf", { precision: 12, scale: 10 }),
    readDepth: integer("readDepth"),
    alternateDepth: integer("alternateDepth"),
    impact: variantImpactEnum("impact").default("UNKNOWN").notNull(),
    clinvarSignificance: varchar("clinvarSignificance", { length: 160 }),
    reviewStatus: variantReviewStatusEnum("reviewStatus")
      .default("unreviewed")
      .notNull(),
    annotation: jsonb("annotation").$type<Record<string, unknown>>(),
    /**
     * Cheap pre-screen deciding which variants are worth engine time.
     *
     * A VCF can carry tens of thousands of variants and the engine takes minutes
     * each, so curating everything is not affordable. Null until the triage pass
     * has run over the case.
     */
    triageTier: variantTriageTierEnum("triageTier"),
    triageScore: integer("triageScore"),
    /** Which rules fired, so a tier can be explained and re-derived. */
    triageReasons: jsonb("triageReasons").$type<string[]>(),
    triagedAt: timestamp("triagedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("variants_org_case_normalized_uq").on(
      table.organizationId,
      table.caseId,
      table.normalizedId
    ),
    unique("variants_id_org_uq").on(table.id, table.organizationId),
    index("variants_workbench_idx").on(
      table.organizationId,
      table.caseId,
      table.gene,
      table.impact
    ),
    // Drives the Workbench triage filter and the bulk "send T1 to curation" action.
    index("variants_triage_idx").on(
      table.organizationId,
      table.caseId,
      table.triageTier,
      table.triageScore.desc()
    ),
    foreignKey({
      name: "variants_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export const germlineVariantNotes = pgTable(
  "germline_variant_notes",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    variantId: integer("variantId").notNull(),
    notes: text("notes").notNull(),
    updatedBy: integer("updatedBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("germline_variant_notes_variant_uq").on(
      table.organizationId,
      table.variantId
    ),
    foreignKey({
      name: "germline_variant_notes_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

// ── Somatic interpretation (isolated from germline ACMG/SAM-VC) ───────────────

export const somaticInterpretationRuns = pgTable(
  "somatic_interpretation_runs",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    contextId: integer("contextId").notNull(),
    status: somaticRunStatusEnum("status").default("queued").notNull(),
    pipelineVersion: varchar("pipelineVersion", { length: 80 }).notNull(),
    rulesetVersion: varchar("rulesetVersion", { length: 80 }).notNull(),
    knowledgeVersions: jsonb("knowledgeVersions")
      .$type<Record<string, string>>()
      .notNull(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    attemptCount: integer("attemptCount").default(0).notNull(),
    maxAttempts: integer("maxAttempts").default(3).notNull(),
    availableAt: timestamp("availableAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar("leaseOwner", { length: 160 }),
    leaseExpiresAt: timestamp("leaseExpiresAt", { withTimezone: true }),
    lastError: text("lastError"),
    requestedBy: integer("requestedBy")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_interpretation_runs_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    index("somatic_interpretation_runs_case_idx").on(
      table.organizationId,
      table.caseId,
      table.createdAt
    ),
    index("somatic_interpretation_runs_worker_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt
    ),
    uniqueIndex("somatic_interpretation_runs_one_active_case_uq")
      .on(table.organizationId, table.caseId)
      .where(
        sql`${table.status} IN ('queued', 'validating', 'normalizing', 'annotating')`
      ),
    check(
      "somatic_interpretation_runs_attempts_ck",
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10 AND ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    foreignKey({
      name: "somatic_interpretation_runs_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_interpretation_runs_context_org_fk",
      columns: [table.contextId, table.organizationId],
      foreignColumns: [
        somaticCaseContexts.id,
        somaticCaseContexts.organizationId,
      ],
    }).onDelete("restrict"),
  ]
);

export const somaticInterpretationRunEvents = pgTable(
  "somatic_interpretation_run_events",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    runId: integer("runId").notNull(),
    status: somaticRunStatusEnum("status").notNull(),
    message: text("message").notNull(),
    progressPercent: integer("progressPercent").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  table => [
    index("somatic_interpretation_run_events_run_idx").on(
      table.organizationId,
      table.runId,
      table.createdAt
    ),
    foreignKey({
      name: "somatic_interpretation_run_events_run_org_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [
        somaticInterpretationRuns.id,
        somaticInterpretationRuns.organizationId,
      ],
    }).onDelete("cascade"),
  ]
);

export const somaticVariantAnalyses = pgTable(
  "somatic_variant_analyses",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    runId: integer("runId").notNull(),
    variantId: integer("variantId").notNull(),
    normalizationStatus: somaticNormalizationStatusEnum("normalizationStatus")
      .default("pending")
      .notNull(),
    normalizationError: text("normalizationError"),
    originalRepresentation: jsonb("originalRepresentation").$type<
      Record<string, unknown>
    >(),
    normalizedRepresentation: jsonb("normalizedRepresentation").$type<
      Record<string, unknown>
    >(),
    transcriptPolicy: varchar("transcriptPolicy", { length: 80 }),
    qcStatus: somaticQcStatusEnum("qcStatus")
      .default("indeterminate")
      .notNull(),
    qcReasons: jsonb("qcReasons").$type<string[]>().notNull(),
    candidate: boolean("candidate").default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_variant_analyses_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_variant_analyses_run_variant_uq").on(
      table.organizationId,
      table.runId,
      table.variantId
    ),
    foreignKey({
      name: "somatic_variant_analyses_run_org_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [
        somaticInterpretationRuns.id,
        somaticInterpretationRuns.organizationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_variant_analyses_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const somaticTherapies = pgTable(
  "somatic_therapies",
  {
    id: surrogateId(),
    genericName: varchar("genericName", { length: 200 }).notNull(),
    brandName: varchar("brandName", { length: 200 }),
    drugClass: varchar("drugClass", { length: 160 }),
    externalIdentifiers: jsonb("externalIdentifiers").$type<
      Record<string, string>
    >(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [unique("somatic_therapies_generic_name_uq").on(table.genericName)]
);

export const somaticRegimens = pgTable("somatic_regimens", {
  id: surrogateId(),
  name: varchar("name", { length: 320 }).notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const somaticRegimenTherapies = pgTable(
  "somatic_regimen_therapies",
  {
    regimenId: integer("regimenId")
      .notNull()
      .references(() => somaticRegimens.id, { onDelete: "cascade" }),
    therapyId: integer("therapyId")
      .notNull()
      .references(() => somaticTherapies.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  table => [
    unique("somatic_regimen_therapies_regimen_therapy_uq").on(
      table.regimenId,
      table.therapyId
    ),
  ]
);

/**
 * Provider records are immutable evidence, not AMP classifications.
 */
export const somaticEvidenceRecords = pgTable(
  "somatic_evidence_records",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    runId: integer("runId").notNull(),
    variantId: integer("variantId").notNull(),
    tumorTypeId: integer("tumorTypeId"),
    regimenId: integer("regimenId").references(() => somaticRegimens.id, {
      onDelete: "restrict",
    }),
    sourceName: varchar("sourceName", { length: 80 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 120 }).notNull(),
    sourceRecordId: varchar("sourceRecordId", { length: 200 }).notNull(),
    sourceNativeLevel: varchar("sourceNativeLevel", { length: 80 }),
    clinicalDomain: evidenceClinicalDomainEnum("clinicalDomain").notNull(),
    clinicalEffect: somaticClinicalEffectEnum("clinicalEffect"),
    direction: evidenceDirectionEnum("direction").default("neutral").notNull(),
    diseaseMatch: diseaseMatchEnum("diseaseMatch").default("unknown").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: varchar("sourceUrl", { length: 1000 }),
    citation: varchar("citation", { length: 500 }),
    rawResponseHash: varchar("rawResponseHash", { length: 64 }).notNull(),
    retrievedAt: timestamp("retrievedAt", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_evidence_records_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_evidence_records_source_record_uq").on(
      table.organizationId,
      table.runId,
      table.sourceName,
      table.sourceVersion,
      table.sourceRecordId
    ),
    index("somatic_evidence_records_variant_idx").on(
      table.organizationId,
      table.variantId,
      table.clinicalDomain
    ),
    foreignKey({
      name: "somatic_evidence_records_run_org_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [
        somaticInterpretationRuns.id,
        somaticInterpretationRuns.organizationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_evidence_records_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_evidence_records_tumor_type_fk",
      columns: [table.tumorTypeId],
      foreignColumns: [somaticTumorTypes.id],
    }).onDelete("restrict"),
  ]
);

/**
 * A variant may carry multiple simultaneous assertions (predictive, diagnostic,
 * prognostic, sensitivity, resistance). The overall display tier is a projection.
 */
export type SomaticProposalFlags = {
  conflict: boolean;
  reasonCodes: string[];
  diseaseMatches: string[];
  appliedRule: {
    recordId: number;
    recordKey: string;
    releaseId: number;
    releaseVersion: string;
    providerCode: string;
    sourceCitation: string;
  } | null;
};

export const somaticClinicalAssertions = pgTable(
  "somatic_clinical_assertions",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    runId: integer("runId").notNull(),
    variantId: integer("variantId").notNull(),
    tumorTypeId: integer("tumorTypeId").notNull(),
    regimenId: integer("regimenId").references(() => somaticRegimens.id, {
      onDelete: "restrict",
    }),
    clinicalDomain: evidenceClinicalDomainEnum("clinicalDomain").notNull(),
    clinicalEffect: somaticClinicalEffectEnum("clinicalEffect"),
    systemTier: somaticTierEnum("systemTier"),
    systemLevel: ampLevelEnum("systemLevel"),
    finalTier: somaticTierEnum("finalTier"),
    finalLevel: ampLevelEnum("finalLevel"),
    oncogenicity: oncogenicityEnum("oncogenicity"),
    status: somaticAssertionStatusEnum("status").default("proposed").notNull(),
    rulesetVersion: varchar("rulesetVersion", { length: 80 }).notNull(),
    rationale: text("rationale").notNull(),
    evidenceIds: jsonb("evidenceIds").$type<number[]>().notNull(),
    proposalFlags: jsonb("proposalFlags")
      .$type<SomaticProposalFlags>()
      .default(
        sql`'{"conflict":false,"reasonCodes":[],"diseaseMatches":[],"appliedRule":null}'::jsonb`
      )
      .notNull(),
    overrideReason: text("overrideReason"),
    reviewedBy: integer("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt", { withTimezone: true }),
    supersedesAssertionId: integer("supersedesAssertionId"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_clinical_assertions_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    index("somatic_clinical_assertions_variant_idx").on(
      table.organizationId,
      table.variantId,
      table.status
    ),
    foreignKey({
      name: "somatic_clinical_assertions_run_org_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [
        somaticInterpretationRuns.id,
        somaticInterpretationRuns.organizationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_clinical_assertions_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_clinical_assertions_tumor_type_fk",
      columns: [table.tumorTypeId],
      foreignColumns: [somaticTumorTypes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_clinical_assertions_supersedes_org_fk",
      columns: [table.supersedesAssertionId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete("restrict"),
  ]
);

// ── Somatic Phase 2–4 safety foundation ──────────────────────────────────────

export type SomaticAssayFindingResult =
  | {
      type: "CNV";
      gene: string;
      copyNumber?: number;
      log2Ratio?: number;
      call: "amplification" | "gain" | "loss" | "deletion";
    }
  | {
      type: "FUSION";
      fivePrimeGene: string;
      threePrimeGene: string;
      inFrame?: boolean;
      supportingReads?: number;
    }
  | {
      type: "MSI";
      score?: number;
      category: "stable" | "low" | "high" | "indeterminate";
    }
  | {
      type: "TMB";
      mutationsPerMb: number;
      category?: "low" | "intermediate" | "high";
    }
  | {
      type: "HRD";
      score?: number;
      category: "negative" | "positive" | "indeterminate";
      method: string;
    };

/**
 * A provider is organization-scoped because license rights and enabled sources
 * vary by tenant. Disabled/unconfigured is the safe initial state, including
 * for OncoKB.
 */
export const somaticKnowledgeProviders = pgTable(
  "somatic_knowledge_providers",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    code: varchar("code", { length: 80 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    licenseStatus: somaticLicenseStatusEnum("licenseStatus")
      .default("unconfigured")
      .notNull(),
    licenseReference: varchar("licenseReference", { length: 500 }),
    licenseValidFrom: timestamp("licenseValidFrom", { withTimezone: true }),
    licenseValidTo: timestamp("licenseValidTo", { withTimezone: true }),
    licenseApprovedBy: integer("licenseApprovedBy").references(() => users.id),
    licenseApprovedAt: timestamp("licenseApprovedAt", { withTimezone: true }),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_knowledge_providers_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_knowledge_providers_org_code_uq").on(
      table.organizationId,
      table.code
    ),
    index("somatic_knowledge_providers_org_enabled_idx").on(
      table.organizationId,
      table.enabled
    ),
  ]
);

export const somaticKnowledgeReleases = pgTable(
  "somatic_knowledge_releases",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    providerId: integer("providerId").notNull(),
    version: varchar("version", { length: 120 }).notNull(),
    status: somaticLifecycleStatusEnum("status").default("draft").notNull(),
    validationStatus: somaticValidationStatusEnum("validationStatus")
      .default("pending")
      .notNull(),
    validationSummary:
      jsonb("validationSummary").$type<Record<string, unknown>>(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    sourcePublishedAt: timestamp("sourcePublishedAt", { withTimezone: true }),
    importedAt: timestamp("importedAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    validatedBy: integer("validatedBy").references(() => users.id),
    validatedAt: timestamp("validatedAt", { withTimezone: true }),
    activatedBy: integer("activatedBy").references(() => users.id),
    activatedAt: timestamp("activatedAt", { withTimezone: true }),
    retiredBy: integer("retiredBy").references(() => users.id),
    retiredAt: timestamp("retiredAt", { withTimezone: true }),
    changeControlId: varchar("changeControlId", { length: 120 }).notNull(),
    changeSummary: text("changeSummary").notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_knowledge_releases_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_knowledge_releases_provider_version_uq").on(
      table.organizationId,
      table.providerId,
      table.version
    ),
    index("somatic_knowledge_releases_org_status_idx").on(
      table.organizationId,
      table.status
    ),
    uniqueIndex("somatic_knowledge_releases_one_active_uq")
      .on(table.organizationId, table.providerId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: "somatic_knowledge_releases_provider_org_fk",
      columns: [table.providerId, table.organizationId],
      foreignColumns: [
        somaticKnowledgeProviders.id,
        somaticKnowledgeProviders.organizationId,
      ],
    }).onDelete("restrict"),
    check(
      "somatic_knowledge_releases_activation_ck",
      sql`${table.status} <> 'active' OR (${table.validationStatus} = 'passed' AND ${table.validatedBy} IS NOT NULL AND ${table.validatedAt} IS NOT NULL AND ${table.activatedBy} IS NOT NULL AND ${table.activatedAt} IS NOT NULL)`
    ),
  ]
);

export const somaticGuidelineRecords = pgTable(
  "somatic_guideline_records",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    releaseId: integer("releaseId").notNull(),
    recordKey: varchar("recordKey", { length: 200 }).notNull(),
    recordVersion: integer("recordVersion").default(1).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    guideline: jsonb("guideline").$type<Record<string, unknown>>().notNull(),
    sourceCitation: varchar("sourceCitation", { length: 1000 }).notNull(),
    effectiveFrom: timestamp("effectiveFrom", { withTimezone: true }),
    effectiveTo: timestamp("effectiveTo", { withTimezone: true }),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_guideline_records_release_key_version_uq").on(
      table.organizationId,
      table.releaseId,
      table.recordKey,
      table.recordVersion
    ),
    foreignKey({
      name: "somatic_guideline_records_release_org_fk",
      columns: [table.releaseId, table.organizationId],
      foreignColumns: [
        somaticKnowledgeReleases.id,
        somaticKnowledgeReleases.organizationId,
      ],
    }).onDelete("cascade"),
  ]
);

/**
 * Normalized, immutable evidence imported into a versioned offline release.
 * These rows are never final AMP classifications.
 */
export const somaticKnowledgeEvidenceRecords = pgTable(
  "somatic_knowledge_evidence_records",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    releaseId: integer("releaseId").notNull(),
    normalizedVariantId: varchar("normalizedVariantId", {
      length: 240,
    }).notNull(),
    sourceRecordId: varchar("sourceRecordId", { length: 200 }).notNull(),
    sourceNativeLevel: varchar("sourceNativeLevel", { length: 80 }),
    clinicalDomain: evidenceClinicalDomainEnum("clinicalDomain").notNull(),
    direction: evidenceDirectionEnum("direction").default("neutral").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: varchar("sourceUrl", { length: 1000 }),
    rawResponseHash: varchar("rawResponseHash", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_knowledge_evidence_records_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_knowledge_evidence_records_release_source_uq").on(
      table.organizationId,
      table.releaseId,
      table.sourceRecordId
    ),
    index("somatic_knowledge_evidence_records_variant_idx").on(
      table.organizationId,
      table.releaseId,
      table.normalizedVariantId
    ),
    foreignKey({
      name: "somatic_knowledge_evidence_records_release_org_fk",
      columns: [table.releaseId, table.organizationId],
      foreignColumns: [
        somaticKnowledgeReleases.id,
        somaticKnowledgeReleases.organizationId,
      ],
    }).onDelete("cascade"),
    check(
      "somatic_knowledge_evidence_records_hash_ck",
      sql`${table.rawResponseHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);

/**
 * Durable, tenant-scoped CIViC ingestion queue. scopeConfig contains only
 * normalized variant coordinates/identifiers; clinical case data is forbidden.
 */
export const somaticCivicImportJobs = pgTable(
  "somatic_civic_import_jobs",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    releaseId: integer("releaseId").notNull(),
    status: somaticCivicImportStatusEnum("status").default("queued").notNull(),
    scopeConfig: jsonb("scopeConfig").$type<NormalizedVariantContext[]>().notNull(),
    snapshotHash: varchar("snapshotHash", { length: 64 }).notNull(),
    queryHash: varchar("queryHash", { length: 64 }).notNull(),
    schemaHash: varchar("schemaHash", { length: 64 }).notNull(),
    adapterHash: varchar("adapterHash", { length: 64 }).notNull(),
    attemptCount: integer("attemptCount").default(0).notNull(),
    maxAttempts: integer("maxAttempts").default(3).notNull(),
    availableAt: timestamp("availableAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar("leaseOwner", { length: 160 }),
    leaseExpiresAt: timestamp("leaseExpiresAt", { withTimezone: true }),
    stats: jsonb("stats").$type<Record<string, number>>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    cancelRequestedAt: timestamp("cancelRequestedAt", { withTimezone: true }),
    cancelRequestedBy: integer("cancelRequestedBy").references(() => users.id),
    requestedBy: integer("requestedBy")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_civic_import_jobs_id_org_release_uq").on(
      table.id,
      table.organizationId,
      table.releaseId
    ),
    index("somatic_civic_import_jobs_org_release_idx").on(
      table.organizationId,
      table.releaseId,
      table.createdAt
    ),
    index("somatic_civic_import_jobs_worker_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt
    ),
    uniqueIndex("somatic_civic_import_jobs_one_active_release_uq")
      .on(table.organizationId, table.releaseId)
      .where(sql`${table.status} IN ('queued', 'running')`),
    foreignKey({
      name: "somatic_civic_import_jobs_release_org_fk",
      columns: [table.releaseId, table.organizationId],
      foreignColumns: [
        somaticKnowledgeReleases.id,
        somaticKnowledgeReleases.organizationId,
      ],
    }).onDelete("cascade"),
    check(
      "somatic_civic_import_jobs_hashes_ck",
      sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$' AND ${table.queryHash} ~ '^[0-9a-f]{64}$' AND ${table.schemaHash} ~ '^[0-9a-f]{64}$' AND ${table.adapterHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "somatic_civic_import_jobs_attempts_ck",
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10 AND ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    check(
      "somatic_civic_import_jobs_scope_array_ck",
      sql`jsonb_typeof(${table.scopeConfig}) = 'array'`
    ),
    check(
      "somatic_civic_import_jobs_scope_no_phi_ck",
      sql`NOT jsonb_path_exists(${table.scopeConfig}, '$[*].keyvalue() ? (@.key like_regex "(patient|case|sample|name|email|phone|address|dob|birth|mrn|clinical)" flag "i")')`
    ),
    check(
      "somatic_civic_import_jobs_lease_ck",
      sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`
    ),
  ]
);

export const somaticCivicImportCheckpoints = pgTable(
  "somatic_civic_import_checkpoints",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    releaseId: integer("releaseId").notNull(),
    jobId: integer("jobId").notNull(),
    scopeIndex: integer("scopeIndex").notNull(),
    operationName: varchar("operationName", { length: 80 }).notNull(),
    pageNumber: integer("pageNumber").default(0).notNull(),
    cursor: varchar("cursor", { length: 1000 }),
    status: somaticCivicCheckpointStatusEnum("status").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_civic_import_checkpoints_operation_uq").on(
      table.organizationId,
      table.jobId,
      table.scopeIndex,
      table.operationName,
      table.pageNumber
    ),
    index("somatic_civic_import_checkpoints_job_idx").on(
      table.organizationId,
      table.jobId,
      table.scopeIndex
    ),
    foreignKey({
      name: "somatic_civic_import_checkpoints_job_org_release_fk",
      columns: [table.jobId, table.organizationId, table.releaseId],
      foreignColumns: [
        somaticCivicImportJobs.id,
        somaticCivicImportJobs.organizationId,
        somaticCivicImportJobs.releaseId,
      ],
    }).onDelete("cascade"),
    check(
      "somatic_civic_import_checkpoints_position_ck",
      sql`${table.scopeIndex} >= 0 AND ${table.pageNumber} >= 0`
    ),
  ]
);

export const somaticCivicRawArchives = pgTable(
  "somatic_civic_raw_archives",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    releaseId: integer("releaseId").notNull(),
    jobId: integer("jobId").notNull(),
    scopeIndex: integer("scopeIndex").notNull(),
    operationName: varchar("operationName", { length: 80 }).notNull(),
    pageNumber: integer("pageNumber").default(0).notNull(),
    requestId: varchar("requestId", { length: 80 }).notNull(),
    rawBodyHash: varchar("rawBodyHash", { length: 64 }).notNull(),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    storageUrl: varchar("storageUrl", { length: 768 }).notNull(),
    envelopeStorageKey: varchar("envelopeStorageKey", { length: 512 }).notNull(),
    envelopeStorageUrl: varchar("envelopeStorageUrl", { length: 768 }).notNull(),
    byteSize: bigint("byteSize", { mode: "number" }).notNull(),
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_civic_raw_archives_request_uq").on(
      table.organizationId,
      table.jobId,
      table.requestId
    ),
    index("somatic_civic_raw_archives_job_operation_idx").on(
      table.organizationId,
      table.jobId,
      table.scopeIndex,
      table.operationName,
      table.pageNumber
    ),
    foreignKey({
      name: "somatic_civic_raw_archives_job_org_release_fk",
      columns: [table.jobId, table.organizationId, table.releaseId],
      foreignColumns: [
        somaticCivicImportJobs.id,
        somaticCivicImportJobs.organizationId,
        somaticCivicImportJobs.releaseId,
      ],
    }).onDelete("cascade"),
    check(
      "somatic_civic_raw_archives_hash_ck",
      sql`${table.rawBodyHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "somatic_civic_raw_archives_position_ck",
      sql`${table.scopeIndex} >= 0 AND ${table.pageNumber} >= 0 AND ${table.byteSize} >= 0`
    ),
  ]
);

export const somaticPanelReportableRegions = pgTable(
  "somatic_panel_reportable_regions",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    panelVersionId: integer("panelVersionId").notNull(),
    regionKey: varchar("regionKey", { length: 240 }).notNull(),
    regionType: somaticRegionTypeEnum("regionType").notNull(),
    findingType: somaticFindingTypeEnum("findingType"),
    gene: varchar("gene", { length: 80 }),
    transcript: varchar("transcript", { length: 120 }),
    chromosome: varchar("chromosome", { length: 16 }),
    start: integer("start"),
    end: integer("end"),
    target: jsonb("target").$type<Record<string, unknown>>(),
    minimumDepth: integer("minimumDepth"),
    minimumCoveragePercent: numeric("minimumCoveragePercent", {
      precision: 5,
      scale: 2,
    }),
    reportable: boolean("reportable").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_panel_regions_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_panel_regions_version_key_uq").on(
      table.organizationId,
      table.panelVersionId,
      table.regionKey
    ),
    foreignKey({
      name: "somatic_panel_regions_version_org_fk",
      columns: [table.panelVersionId, table.organizationId],
      foreignColumns: [
        somaticPanelVersions.id,
        somaticPanelVersions.organizationId,
      ],
    }).onDelete("cascade"),
  ]
);

export const somaticCaseCoverageSummaries = pgTable(
  "somatic_case_coverage_summaries",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    panelVersionId: integer("panelVersionId").notNull(),
    validationStatus: somaticValidationStatusEnum("validationStatus")
      .default("pending")
      .notNull(),
    completeRegionCount: integer("completeRegionCount").default(0).notNull(),
    expectedRegionCount: integer("expectedRegionCount").default(0).notNull(),
    qcMetrics: jsonb("qcMetrics").$type<Record<string, unknown>>().notNull(),
    sourceArtifactHash: varchar("sourceArtifactHash", { length: 64 }),
    validationHash: varchar("validationHash", { length: 64 }),
    validatedBy: integer("validatedBy").references(() => users.id),
    validatedAt: timestamp("validatedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_case_coverage_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_case_coverage_identity_uq").on(
      table.id,
      table.organizationId,
      table.caseId,
      table.panelVersionId
    ),
    unique("somatic_case_coverage_case_panel_uq").on(
      table.organizationId,
      table.caseId,
      table.panelVersionId
    ),
    foreignKey({
      name: "somatic_case_coverage_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_case_coverage_panel_org_fk",
      columns: [table.panelVersionId, table.organizationId],
      foreignColumns: [
        somaticPanelVersions.id,
        somaticPanelVersions.organizationId,
      ],
    }).onDelete("restrict"),
    check(
      "somatic_case_coverage_validation_ck",
      sql`${table.validationStatus} <> 'passed' OR (${table.expectedRegionCount} > 0 AND ${table.completeRegionCount} = ${table.expectedRegionCount} AND ${table.validationHash} IS NOT NULL AND ${table.validatedBy} IS NOT NULL AND ${table.validatedAt} IS NOT NULL)`
    ),
    check(
      "somatic_case_coverage_source_hash_ck",
      sql`${table.sourceArtifactHash} IS NULL OR ${table.sourceArtifactHash} ~ '^[0-9a-f]{64}$'`
    ),
  ]
);

export const somaticCaseRegionCoverage = pgTable(
  "somatic_case_region_coverage",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    coverageSummaryId: integer("coverageSummaryId").notNull(),
    panelRegionId: integer("panelRegionId").notNull(),
    meanDepth: numeric("meanDepth", { precision: 12, scale: 2 }),
    coveredPercent: numeric("coveredPercent", { precision: 5, scale: 2 }),
    qcPassed: boolean("qcPassed").notNull(),
    qcReasons: jsonb("qcReasons").$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_case_region_coverage_summary_region_uq").on(
      table.organizationId,
      table.coverageSummaryId,
      table.panelRegionId
    ),
    foreignKey({
      name: "somatic_case_region_coverage_summary_org_fk",
      columns: [table.coverageSummaryId, table.organizationId],
      foreignColumns: [
        somaticCaseCoverageSummaries.id,
        somaticCaseCoverageSummaries.organizationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_case_region_coverage_region_org_fk",
      columns: [table.panelRegionId, table.organizationId],
      foreignColumns: [
        somaticPanelReportableRegions.id,
        somaticPanelReportableRegions.organizationId,
      ],
    }).onDelete("restrict"),
  ]
);

export const somaticAssayFindings = pgTable(
  "somatic_assay_findings",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    panelVersionId: integer("panelVersionId").notNull(),
    coverageSummaryId: integer("coverageSummaryId"),
    findingType: somaticFindingTypeEnum("findingType").notNull(),
    status: somaticFindingStatusEnum("status").notNull(),
    result: jsonb("result").$type<SomaticAssayFindingResult>(),
    reportable: boolean("reportable").default(false).notNull(),
    reportabilityReasons: jsonb("reportabilityReasons")
      .$type<string[]>()
      .notNull(),
    sourceRunId: varchar("sourceRunId", { length: 160 }),
    sourceArtifactFileId: integer("sourceArtifactFileId"),
    sourceArtifactHash: varchar("sourceArtifactHash", { length: 64 }),
    reviewedBy: integer("reviewedBy").references(() => users.id),
    reviewedAt: timestamp("reviewedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_assay_findings_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    index("somatic_assay_findings_case_type_idx").on(
      table.organizationId,
      table.caseId,
      table.findingType
    ),
    foreignKey({
      name: "somatic_assay_findings_artifact_org_case_fk",
      columns: [
        table.sourceArtifactFileId,
        table.organizationId,
        table.caseId,
      ],
      foreignColumns: [
        caseFiles.id,
        caseFiles.organizationId,
        caseFiles.caseId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_assay_findings_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_assay_findings_panel_org_fk",
      columns: [table.panelVersionId, table.organizationId],
      foreignColumns: [
        somaticPanelVersions.id,
        somaticPanelVersions.organizationId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_assay_findings_coverage_org_fk",
      columns: [
        table.coverageSummaryId,
        table.organizationId,
        table.caseId,
        table.panelVersionId,
      ],
      foreignColumns: [
        somaticCaseCoverageSummaries.id,
        somaticCaseCoverageSummaries.organizationId,
        somaticCaseCoverageSummaries.caseId,
        somaticCaseCoverageSummaries.panelVersionId,
      ],
    }).onDelete("restrict"),
    check(
      "somatic_assay_findings_negative_reportable_ck",
      sql`NOT ${table.reportable} OR ${table.status} NOT IN ('not_detected', 'not_tested') OR ${table.coverageSummaryId} IS NOT NULL`
    ),
    check(
      "somatic_assay_findings_result_type_ck",
      sql`${table.result} IS NULL OR ${table.result}->>'type' = ${table.findingType}::text`
    ),
    check(
      "somatic_assay_findings_artifact_hash_ck",
      sql`(${table.sourceArtifactFileId} IS NULL AND ${table.sourceArtifactHash} IS NULL) OR (${table.sourceArtifactFileId} IS NOT NULL AND ${table.sourceArtifactHash} ~ '^[0-9a-f]{64}$')`
    ),
  ]
);

export const somaticOrganizationPolicyProfiles = pgTable(
  "somatic_organization_policy_profiles",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    name: varchar("name", { length: 160 }).notNull(),
    version: integer("version").notNull(),
    status: somaticLifecycleStatusEnum("status").default("draft").notNull(),
    allowNegativeReporting: boolean("allowNegativeReporting")
      .default(false)
      .notNull(),
    enableOncoKb: boolean("enableOncoKb").default(false).notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    changeControlId: varchar("changeControlId", { length: 120 }).notNull(),
    approvedBy: integer("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt", { withTimezone: true }),
    activatedBy: integer("activatedBy").references(() => users.id),
    activatedAt: timestamp("activatedAt", { withTimezone: true }),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_policy_profiles_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_policy_profiles_org_name_version_uq").on(
      table.organizationId,
      table.name,
      table.version
    ),
    uniqueIndex("somatic_policy_profiles_one_active_uq")
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
    check(
      "somatic_policy_profiles_activation_ck",
      sql`${table.status} <> 'active' OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL AND ${table.activatedBy} IS NOT NULL AND ${table.activatedAt} IS NOT NULL)`
    ),
  ]
);

export const somaticReinterpretationTasks = pgTable(
  "somatic_reinterpretation_tasks",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    releaseId: integer("releaseId").notNull(),
    findingId: integer("findingId"),
    changeKind: varchar("changeKind", { length: 40 })
      .default("knowledge_release")
      .notNull(),
    changeKey: varchar("changeKey", { length: 200 }),
    status: somaticTaskStatusEnum("status").default("open").notNull(),
    reason: text("reason").notNull(),
    impact: jsonb("impact").$type<Record<string, unknown>>().notNull(),
    previousReleaseVersion: varchar("previousReleaseVersion", { length: 120 }),
    targetReleaseVersion: varchar("targetReleaseVersion", {
      length: 120,
    }).notNull(),
    interpretationRunId: integer("interpretationRunId"),
    enqueuedBy: integer("enqueuedBy").references(() => users.id),
    enqueuedAt: timestamp("enqueuedAt", { withTimezone: true }),
    assignedTo: integer("assignedTo").references(() => users.id),
    completedBy: integer("completedBy").references(() => users.id),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_reinterpretation_tasks_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    index("somatic_reinterpretation_tasks_queue_idx").on(
      table.organizationId,
      table.status,
      table.createdAt
    ),
    uniqueIndex("somatic_reinterpretation_tasks_one_open_change_uq")
      .on(
        table.organizationId,
        table.caseId,
        sql`COALESCE(${table.changeKey}, 'release:' || ${table.releaseId}::text)`
      )
      .where(sql`${table.status} IN ('open', 'in_review')`),
    foreignKey({
      name: "somatic_reinterpretation_tasks_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "somatic_reinterpretation_tasks_release_org_fk",
      columns: [table.releaseId, table.organizationId],
      foreignColumns: [
        somaticKnowledgeReleases.id,
        somaticKnowledgeReleases.organizationId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_reinterpretation_tasks_finding_org_fk",
      columns: [table.findingId, table.organizationId],
      foreignColumns: [
        somaticAssayFindings.id,
        somaticAssayFindings.organizationId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "somatic_reinterpretation_tasks_run_org_fk",
      columns: [table.interpretationRunId, table.organizationId],
      foreignColumns: [
        somaticInterpretationRuns.id,
        somaticInterpretationRuns.organizationId,
      ],
    }).onDelete("restrict"),
  ]
);

// ── Curation batches (SAM-VC workbench) ────────────────────────────────────────

/**
 * A named set of ad-hoc curation runs.
 *
 * SAM-VC's workbench is organized as batches: a curator adds gene + HGVS rows,
 * runs them, and reviews one entry at a time while stepping through the rest.
 * "Single variants" is the shared batch those one-off runs land in.
 */
export const curationBatches = pgTable(
  "curation_batches",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    name: varchar("name", { length: 160 }).notNull(),
    createdBy: integer("createdBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("curation_batches_id_org_uq").on(table.id, table.organizationId),
    unique("curation_batches_org_name_uq").on(table.organizationId, table.name),
  ]
);

// ── Curation runs (SAM-VC engine) ──────────────────────────────────────────────

/**
 * Variant-level engine jobs, kept separate from `analysis_jobs`.
 *
 * `analysis_jobs` is case-level (one VCF ingest or one exome pipeline per case);
 * the curation engine works one variant at a time and takes minutes each. Mixing
 * the two granularities into one table would make both queues harder to reason
 * about, so this is a dedicated lease-based queue drained by Python workers over
 * the Engine API.
 */
export const curationRuns = pgTable(
  "curation_runs",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    /** Null for ad-hoc curation performed outside any case. */
    caseId: integer("caseId"),
    /** Null for ad-hoc curation of a variant that was never ingested. */
    variantId: integer("variantId"),
    /** Workbench batch this run belongs to. Null for case-bound triage runs. */
    batchId: integer("batchId"),
    /** Curator-saved institutional call. Independent of the engine ACMG label. */
    institutionalLabel: varchar("institutionalLabel", { length: 80 }),
    institutionalClass: varchar("institutionalClass", { length: 16 }),
    status: curationRunStatusEnum("status").default("queued").notNull(),
    /** Higher runs first. Interactive requests outrank bulk triage batches. */
    priority: integer("priority").default(0).notNull(),
    input: jsonb("input").$type<CurationRunInput>().notNull(),

    attempt: integer("attempt").default(0).notNull(),
    maxAttempts: integer("maxAttempts").default(3).notNull(),
    /** Set on claim. Once it passes, the reaper may requeue the run. */
    leaseExpiresAt: timestamp("leaseExpiresAt", { withTimezone: true }),
    workerId: varchar("workerId", { length: 120 }),
    heartbeatAt: timestamp("heartbeatAt", { withTimezone: true }),

    /** Object-storage key for the CurationDocument the client renders. */
    documentKey: varchar("documentKey", { length: 512 }),
    documentHash: varchar("documentHash", { length: 64 }),
    /** Object-storage key for the unmodified engine response. */
    rawKey: varchar("rawKey", { length: 512 }),
    rawHash: varchar("rawHash", { length: 64 }),
    /** Queryable projection of the document; the document itself stays in storage. */
    summary: jsonb("summary").$type<CurationSummary>(),

    engineVersion: varchar("engineVersion", { length: 40 }),
    contractVersion: varchar("contractVersion", { length: 16 }),
    error: jsonb("error").$type<CurationRunError>(),
    timings: jsonb("timings").$type<Record<string, number>>(),

    /** Null when the run was queued by a system pass rather than a person. */
    requestedBy: integer("requestedBy").references(() => users.id),
    queuedAt: timestamp("queuedAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("curation_runs_id_org_uq").on(table.id, table.organizationId),
    // Drives the `FOR UPDATE SKIP LOCKED` claim query.
    index("curation_runs_claim_idx")
      .on(table.priority.desc(), table.queuedAt.asc())
      .where(sql`${table.status} = 'queued'`),
    // Drives the reaper sweep over expired leases.
    index("curation_runs_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} in ('loading', 'running')`),
    index("curation_runs_org_status_idx").on(
      table.organizationId,
      table.status,
      table.queuedAt
    ),
    index("curation_runs_variant_idx").on(
      table.organizationId,
      table.variantId
    ),
    index("curation_runs_case_idx").on(table.organizationId, table.caseId),
    index("curation_runs_batch_idx").on(table.organizationId, table.batchId),
    // One variant cannot sit in the queue twice. Ad-hoc runs have a null
    // variantId and Postgres treats those as distinct, so they are unaffected.
    uniqueIndex("curation_runs_active_variant_uq")
      .on(table.organizationId, table.variantId)
      .where(sql`${table.status} in ('queued', 'loading', 'running')`),
    index("curation_runs_summary_gin").using("gin", table.summary),
    foreignKey({
      name: "curation_runs_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "curation_runs_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "curation_runs_batch_org_fk",
      columns: [table.batchId, table.organizationId],
      foreignColumns: [curationBatches.id, curationBatches.organizationId],
    }).onDelete("cascade"),
  ]
);

export const curationRunEvents = pgTable(
  "curation_run_events",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    runId: integer("runId").notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    message: text("message").notNull(),
    progressPercent: integer("progressPercent").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  table => [
    index("curation_run_events_run_idx").on(
      table.organizationId,
      table.runId,
      table.createdAt
    ),
    foreignKey({
      name: "curation_run_events_run_org_fk",
      columns: [table.runId, table.organizationId],
      foreignColumns: [curationRuns.id, curationRuns.organizationId],
    }).onDelete("cascade"),
  ]
);

export const evidenceItems = pgTable(
  "evidence_items",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    variantId: integer("variantId").notNull(),
    source: evidenceSourceEnum("source").notNull(),
    clinicalDomain: evidenceClinicalDomainEnum("clinicalDomain")
      .default("other")
      .notNull(),
    sourceRecordId: varchar("sourceRecordId", { length: 160 }),
    title: text("title").notNull(),
    url: varchar("url", { length: 1000 }),
    excerpt: text("excerpt").notNull(),
    direction: evidenceDirectionEnum("direction").default("neutral").notNull(),
    evidenceLevel: varchar("evidenceLevel", { length: 80 }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    origin: evidenceOriginEnum("origin").default("human").notNull(),
    /** Curation run that produced this row; null for human-entered evidence. */
    curationRunId: integer("curationRunId"),
    accessedAt: timestamp("accessedAt", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null when the engine wrote the row — see `evidenceOriginEnum`. */
    createdBy: integer("createdBy").references(() => users.id),
    createdAt: createdAt(),
  },
  table => [
    index("evidence_variant_idx").on(table.organizationId, table.variantId),
    // Lets a re-run replace exactly the rows its predecessor wrote.
    index("evidence_curation_run_idx").on(
      table.organizationId,
      table.curationRunId
    ),
    foreignKey({
      name: "evidence_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
    // Deleting a run drops its suggestions but leaves human evidence untouched,
    // because human rows carry a null curationRunId.
    //
    // Migration 0006 narrows this to `ON DELETE SET NULL ("curationRunId")`. Drizzle
    // cannot express the column list, and without it Postgres also nulls the NOT NULL
    // `organizationId` and every delete fails. Do not recreate this constraint from
    // generated SQL alone.
    foreignKey({
      name: "evidence_curation_run_org_fk",
      columns: [table.curationRunId, table.organizationId],
      foreignColumns: [curationRuns.id, curationRuns.organizationId],
    }).onDelete("set null"),
  ]
);

export const interpretations = pgTable(
  "interpretations",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    variantId: integer("variantId").notNull(),
    mode: interpretationModeEnum("mode").notNull(),
    germlineClassification: germlineClassificationEnum(
      "germlineClassification"
    ),
    somaticTier: somaticTierEnum("somaticTier"),
    oncogenicity: oncogenicityEnum("oncogenicity"),
    clinicalSignificance: varchar("clinicalSignificance", { length: 160 }),
    diseaseContext: varchar("diseaseContext", { length: 255 }),
    rationale: text("rationale").notNull(),
    status: interpretationStatusEnum("status").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    origin: evidenceOriginEnum("origin").default("human").notNull(),
    /**
     * Null when the curation engine opened the draft. The engine has no account,
     * and attributing its draft to an arbitrary user would make the audit trail
     * claim someone acted when they did not. `approvedBy` stays required, so no
     * interpretation can reach `approved` without a named person.
     */
    createdBy: integer("createdBy").references(() => users.id),
    approvedBy: integer("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("interpretations_org_variant_version_uq").on(
      table.organizationId,
      table.variantId,
      table.version
    ),
    unique("interpretations_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "interpretations_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const criteriaAssessments = pgTable(
  "criteria_assessments",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    interpretationId: integer("interpretationId").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    state: criterionStateEnum("state").notNull(),
    strengthOverride: varchar("strengthOverride", { length: 40 }),
    evidenceIds: jsonb("evidenceIds").$type<number[]>().notNull(),
    note: text("note"),
    origin: evidenceOriginEnum("origin").default("human").notNull(),
    /** Curation run that suggested this criterion; null when a person added it. */
    curationRunId: integer("curationRunId"),
    /** Null when the engine wrote the row — see `evidenceOriginEnum`. */
    updatedBy: integer("updatedBy").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("criteria_interp_code_uq").on(
      table.organizationId,
      table.interpretationId,
      table.code
    ),
    foreignKey({
      name: "criteria_interpretation_org_fk",
      columns: [table.interpretationId, table.organizationId],
      foreignColumns: [interpretations.id, interpretations.organizationId],
    }).onDelete("cascade"),
    // Narrowed to `ON DELETE SET NULL ("curationRunId")` by migration 0006 — see the
    // matching note on evidence_curation_run_org_fk.
    foreignKey({
      name: "criteria_curation_run_org_fk",
      columns: [table.curationRunId, table.organizationId],
      foreignColumns: [curationRuns.id, curationRuns.organizationId],
    }).onDelete("set null"),
  ]
);

// ── AI copilot ─────────────────────────────────────────────────────────────────

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    variantId: integer("variantId").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    modelId: varchar("modelId", { length: 120 }).notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("ai_conversations_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "ai_conversations_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    conversationId: integer("conversationId").notNull(),
    role: aiMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    citationIds: jsonb("citationIds").$type<number[]>().notNull(),
    createdAt: createdAt(),
  },
  table => [
    index("ai_messages_conversation_idx").on(
      table.organizationId,
      table.conversationId,
      table.createdAt
    ),
    foreignKey({
      name: "ai_messages_conversation_org_fk",
      columns: [table.conversationId, table.organizationId],
      foreignColumns: [aiConversations.id, aiConversations.organizationId],
    }).onDelete("cascade"),
  ]
);

// ── Reporting and audit ────────────────────────────────────────────────────────

export type SomaticReportTemplateSchema = {
  schemaVersion: "1";
  name: string;
  locale: string;
  sections: Array<{
    id:
      | "case_summary"
      | "significant_findings"
      | "genomic_signatures"
      | "vus"
      | "variant_details"
      | "methodology"
      | "limitations"
      | "references"
      | "signatures";
    visible: boolean;
    title: string;
    editableIntro?: string;
  }>;
  includeTierIV: boolean;
  header?: string;
  footer?: string;
  disclaimer: string;
  negativeResult?: {
    title: string;
    summary: string;
    interpretation: string;
    limitations: string;
  };
};

export const somaticReportTemplates = pgTable(
  "somatic_report_templates",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    name: varchar("name", { length: 200 }).notNull(),
    activeVersionId: integer("activeVersionId"),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    unique("somatic_report_templates_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_report_templates_org_name_uq").on(
      table.organizationId,
      table.name
    ),
  ]
);

export const somaticReportTemplateVersions = pgTable(
  "somatic_report_template_versions",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    templateId: integer("templateId").notNull(),
    version: integer("version").notNull(),
    status: somaticReportTemplateStatusEnum("status")
      .default("draft")
      .notNull(),
    schema: jsonb("schema").$type<SomaticReportTemplateSchema>().notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    publishedBy: integer("publishedBy").references(() => users.id),
    publishedAt: timestamp("publishedAt", { withTimezone: true }),
    createdAt: createdAt(),
  },
  table => [
    unique("somatic_report_template_versions_id_org_uq").on(
      table.id,
      table.organizationId
    ),
    unique("somatic_report_template_versions_template_version_uq").on(
      table.organizationId,
      table.templateId,
      table.version
    ),
    foreignKey({
      name: "somatic_report_template_versions_template_org_fk",
      columns: [table.templateId, table.organizationId],
      foreignColumns: [
        somaticReportTemplates.id,
        somaticReportTemplates.organizationId,
      ],
    }).onDelete("cascade"),
  ]
);

export const reports = pgTable(
  "reports",
  {
    id: surrogateId(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    caseId: integer("caseId").notNull(),
    version: integer("version").notNull(),
    status: reportStatusEnum("status").default("draft").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    somaticTemplateVersionId: integer("somaticTemplateVersionId"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    snapshotHash: varchar("snapshotHash", { length: 64 }),
    parentReportId: integer("parentReportId"),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    signedBy: integer("signedBy").references(() => users.id),
    signedAt: timestamp("signedAt", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("reports_org_case_version_uq").on(
      table.organizationId,
      table.caseId,
      table.version
    ),
    unique("reports_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "reports_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "reports_parent_org_fk",
      columns: [table.parentReportId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "reports_somatic_template_version_org_fk",
      columns: [table.somaticTemplateVersionId, table.organizationId],
      foreignColumns: [
        somaticReportTemplateVersions.id,
        somaticReportTemplateVersions.organizationId,
      ],
    }).onDelete("restrict"),
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: integer("organizationId")
      .notNull()
      .references(() => organizations.id),
    actorUserId: integer("actorUserId").references(() => users.id),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entityType", { length: 80 }).notNull(),
    entityId: varchar("entityId", { length: 80 }).notNull(),
    requestId: varchar("requestId", { length: 80 }).notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    ipAddress: varchar("ipAddress", { length: 64 }),
    userAgent: varchar("userAgent", { length: 512 }),
    createdAt: createdAt(),
  },
  table => [
    index("audit_events_org_time_idx").on(
      table.organizationId,
      table.createdAt
    ),
    index("audit_events_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
  ]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ClinicalCase = typeof cases.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type Interpretation = typeof interpretations.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type CurationRun = typeof curationRuns.$inferSelect;
export type CurationRunEvent = typeof curationRunEvents.$inferSelect;
export type SomaticCaseContext = typeof somaticCaseContexts.$inferSelect;
export type SomaticInterpretationRun =
  typeof somaticInterpretationRuns.$inferSelect;
export type SomaticClinicalAssertion =
  typeof somaticClinicalAssertions.$inferSelect;
export type SomaticReportTemplate = typeof somaticReportTemplates.$inferSelect;
export type SomaticReportTemplateVersion =
  typeof somaticReportTemplateVersions.$inferSelect;

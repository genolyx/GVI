import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
const createdAt = () => timestamp("createdAt", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updatedAt", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
const surrogateId = () => integer("id").primaryKey().generatedAlwaysAsIdentity();

// ── Enum types ─────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["user", "admin", "super_admin"]);
export const organizationStatusEnum = pgEnum("organization_status", ["active", "suspended"]);
export const isolationModeEnum = pgEnum("isolation_mode", ["shared_schema", "dedicated_database"]);
export const organizationRoleEnum = pgEnum("organization_role", [
  "administrator",
  "analyst",
  "clinician",
  "viewer",
]);
export const membershipStatusEnum = pgEnum("membership_status", ["invited", "active", "suspended"]);
export const projectStatusEnum = pgEnum("project_status", ["active", "archived"]);
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
export const referenceBuildEnum = pgEnum("reference_build", ["GRCh37", "GRCh38"]);
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
  "other",
]);
export const caseFileStatusEnum = pgEnum("case_file_status", ["uploaded", "verified", "rejected"]);
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
export const interpretationModeEnum = pgEnum("interpretation_mode", ["germline", "somatic"]);
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
]);
export const interpretationStatusEnum = pgEnum("interpretation_status", [
  "draft",
  "in_review",
  "approved",
]);
export const criterionStateEnum = pgEnum("criterion_state", ["met", "not_met", "not_applicable"]);
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
export const aiMessageRoleEnum = pgEnum("ai_message_role", ["user", "assistant"]);
export const reportStatusEnum = pgEnum("report_status", [
  "draft",
  "in_review",
  "signed",
  "amended",
]);

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
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true }).defaultNow().notNull(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: surrogateId(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: organizationStatusEnum("status").default("active").notNull(),
    dataRegion: varchar("dataRegion", { length: 32 }).default("KR").notNull(),
    isolationMode: isolationModeEnum("isolationMode").default("shared_schema").notNull(),
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
    joinedAt: timestamp("joinedAt", { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("organization_members_org_user_uq").on(table.organizationId, table.userId),
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
    index("organization_invites_org_email_idx").on(table.organizationId, table.email),
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
    consentSecondaryFindings: boolean("consentSecondaryFindings").default(false).notNull(),
    consentDataUse: boolean("consentDataUse").default(false).notNull(),
    createdBy: integer("createdBy")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  table => [
    uniqueIndex("cases_org_number_uq").on(table.organizationId, table.caseNumber),
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
    tumorContentPercent: numeric("tumorContentPercent", { precision: 5, scale: 2 }),
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
    uniqueIndex("case_files_org_storage_uq").on(table.organizationId, table.storageKey),
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
    index("analysis_jobs_org_status_idx").on(table.organizationId, table.status),
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
    index("analysis_events_job_idx").on(table.organizationId, table.jobId, table.createdAt),
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
    reviewStatus: variantReviewStatusEnum("reviewStatus").default("unreviewed").notNull(),
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
    queuedAt: timestamp("queuedAt", { withTimezone: true }).defaultNow().notNull(),
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
    index("curation_runs_org_status_idx").on(table.organizationId, table.status, table.queuedAt),
    index("curation_runs_variant_idx").on(table.organizationId, table.variantId),
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
    clinicalDomain: evidenceClinicalDomainEnum("clinicalDomain").default("other").notNull(),
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
    accessedAt: timestamp("accessedAt", { withTimezone: true }).defaultNow().notNull(),
    /** Null when the engine wrote the row — see `evidenceOriginEnum`. */
    createdBy: integer("createdBy").references(() => users.id),
    createdAt: createdAt(),
  },
  table => [
    index("evidence_variant_idx").on(table.organizationId, table.variantId),
    // Lets a re-run replace exactly the rows its predecessor wrote.
    index("evidence_curation_run_idx").on(table.organizationId, table.curationRunId),
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
    germlineClassification: germlineClassificationEnum("germlineClassification"),
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
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
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
    index("audit_events_org_time_idx").on(table.organizationId, table.createdAt),
    index("audit_events_entity_idx").on(table.organizationId, table.entityType, table.entityId),
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

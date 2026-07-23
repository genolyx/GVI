import {
  bigint,
  boolean,
  decimal,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const organizations = mysqlTable(
  "organizations",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: mysqlEnum("status", ["active", "suspended"]).default("active").notNull(),
    dataRegion: varchar("dataRegion", { length: 32 }).default("KR").notNull(),
    isolationMode: mysqlEnum("isolationMode", ["shared_schema", "dedicated_database"])
      .default("shared_schema")
      .notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("organizations_slug_uq").on(table.slug)]
);

export const organizationMembers = mysqlTable(
  "organization_members",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    userId: int("userId").notNull().references(() => users.id),
    role: mysqlEnum("role", ["administrator", "analyst", "clinician", "viewer"]).notNull(),
    status: mysqlEnum("status", ["invited", "active", "suspended"])
      .default("active")
      .notNull(),
    invitedBy: int("invitedBy").references(() => users.id),
    joinedAt: timestamp("joinedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("organization_members_org_user_uq").on(table.organizationId, table.userId),
    index("organization_members_user_idx").on(table.userId, table.status),
  ]
);

export const organizationInvites = mysqlTable(
  "organization_invites",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    email: varchar("email", { length: 320 }).notNull(),
    role: mysqlEnum("role", ["administrator", "analyst", "clinician", "viewer"]).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    acceptedAt: timestamp("acceptedAt"),
    revokedAt: timestamp("revokedAt"),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("organization_invites_token_uq").on(table.tokenHash),
    index("organization_invites_org_email_idx").on(table.organizationId, table.email),
  ]
);

export const projects = mysqlTable(
  "projects",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    name: varchar("name", { length: 160 }).notNull(),
    code: varchar("code", { length: 40 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("projects_org_code_uq").on(table.organizationId, table.code),
    uniqueIndex("projects_id_org_uq").on(table.id, table.organizationId),
    index("projects_org_status_idx").on(table.organizationId, table.status),
  ]
);

export const cases = mysqlTable(
  "cases",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    projectId: int("projectId").notNull(),
    caseNumber: varchar("caseNumber", { length: 64 }).notNull(),
    patientAlias: varchar("patientAlias", { length: 120 }).notNull(),
    purpose: mysqlEnum("purpose", ["germline", "somatic"]).notNull(),
    inputType: mysqlEnum("inputType", ["vcf", "fastq"]).notNull(),
    status: mysqlEnum("status", [
      "draft",
      "queued",
      "running",
      "review_ready",
      "in_review",
      "reported",
      "failed",
    ]).default("draft").notNull(),
    referenceBuild: mysqlEnum("referenceBuild", ["GRCh37", "GRCh38"]).notNull(),
    panelName: varchar("panelName", { length: 160 }),
    indication: text("indication"),
    phenotypeText: text("phenotypeText"),
    consentClinicalAnalysis: boolean("consentClinicalAnalysis").notNull(),
    consentSecondaryFindings: boolean("consentSecondaryFindings").default(false).notNull(),
    consentDataUse: boolean("consentDataUse").default(false).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("cases_org_number_uq").on(table.organizationId, table.caseNumber),
    uniqueIndex("cases_id_org_uq").on(table.id, table.organizationId),
    index("cases_org_status_idx").on(table.organizationId, table.status),
    index("cases_project_idx").on(table.organizationId, table.projectId),
    foreignKey({
      name: "cases_project_org_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("restrict"),
  ]
);

export const samples = mysqlTable(
  "samples",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    caseId: int("caseId").notNull(),
    sampleCode: varchar("sampleCode", { length: 80 }).notNull(),
    role: mysqlEnum("role", ["proband", "mother", "father", "tumor", "normal", "other"]).notNull(),
    specimenType: varchar("specimenType", { length: 100 }).notNull(),
    tumorContentPercent: decimal("tumorContentPercent", { precision: 5, scale: 2 }),
    collectedAt: timestamp("collectedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("samples_org_case_code_uq").on(table.organizationId, table.caseId, table.sampleCode),
    uniqueIndex("samples_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "samples_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export const caseFiles = mysqlTable(
  "case_files",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    caseId: int("caseId").notNull(),
    sampleId: int("sampleId"),
    kind: mysqlEnum("kind", ["vcf", "fastq_r1", "fastq_r2", "bam", "bai", "report", "other"]).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    storageUrl: varchar("storageUrl", { length: 768 }).notNull(),
    mimeType: varchar("mimeType", { length: 160 }).notNull(),
    byteSize: bigint("byteSize", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["uploaded", "verified", "rejected"]).default("uploaded").notNull(),
    uploadedBy: int("uploadedBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
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

export const analysisJobs = mysqlTable(
  "analysis_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    caseId: int("caseId").notNull(),
    pipeline: mysqlEnum("pipeline", ["vcf_ingest", "gx_exome", "gx_somatic"]).notNull(),
    status: mysqlEnum("status", ["queued", "running", "review_ready", "failed", "completed"])
      .default("queued")
      .notNull(),
    progressPercent: int("progressPercent").default(0).notNull(),
    externalJobId: varchar("externalJobId", { length: 160 }),
    idempotencyKey: varchar("idempotencyKey", { length: 80 }).notNull(),
    manifest: json("manifest").$type<Record<string, unknown>>().notNull(),
    errorMessage: text("errorMessage"),
    createdBy: int("createdBy").notNull().references(() => users.id),
    claimedAt: timestamp("claimedAt"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("analysis_jobs_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("analysis_jobs_id_org_uq").on(table.id, table.organizationId),
    index("analysis_jobs_org_status_idx").on(table.organizationId, table.status),
    foreignKey({
      name: "analysis_jobs_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export const analysisEvents = mysqlTable(
  "analysis_events",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    jobId: int("jobId").notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    message: text("message").notNull(),
    progressPercent: int("progressPercent").notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
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

export const variants = mysqlTable(
  "variants",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    caseId: int("caseId").notNull(),
    normalizedId: varchar("normalizedId", { length: 255 }).notNull(),
    referenceBuild: mysqlEnum("referenceBuild", ["GRCh37", "GRCh38"]).notNull(),
    chromosome: varchar("chromosome", { length: 16 }).notNull(),
    position: int("position").notNull(),
    referenceAllele: text("referenceAllele").notNull(),
    alternateAllele: text("alternateAllele").notNull(),
    gene: varchar("gene", { length: 80 }),
    transcript: varchar("transcript", { length: 120 }),
    hgvsC: varchar("hgvsC", { length: 255 }),
    hgvsP: varchar("hgvsP", { length: 255 }),
    consequence: varchar("consequence", { length: 160 }),
    variantType: mysqlEnum("variantType", ["SNV", "INDEL", "CNV", "SV", "FUSION", "OTHER"]).notNull(),
    zygosity: varchar("zygosity", { length: 40 }),
    populationAf: decimal("populationAf", { precision: 12, scale: 10 }),
    vaf: decimal("vaf", { precision: 12, scale: 10 }),
    readDepth: int("readDepth"),
    alternateDepth: int("alternateDepth"),
    impact: mysqlEnum("impact", ["HIGH", "MODERATE", "LOW", "MODIFIER", "UNKNOWN"])
      .default("UNKNOWN")
      .notNull(),
    clinvarSignificance: varchar("clinvarSignificance", { length: 160 }),
    reviewStatus: mysqlEnum("reviewStatus", ["unreviewed", "reviewing", "reviewed", "flagged"])
      .default("unreviewed")
      .notNull(),
    annotation: json("annotation").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("variants_org_case_normalized_uq").on(table.organizationId, table.caseId, table.normalizedId),
    uniqueIndex("variants_id_org_uq").on(table.id, table.organizationId),
    index("variants_workbench_idx").on(table.organizationId, table.caseId, table.gene, table.impact),
    foreignKey({
      name: "variants_case_org_fk",
      columns: [table.caseId, table.organizationId],
      foreignColumns: [cases.id, cases.organizationId],
    }).onDelete("cascade"),
  ]
);

export const evidenceItems = mysqlTable(
  "evidence_items",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    variantId: int("variantId").notNull(),
    source: mysqlEnum("source", ["ClinVar", "OMIM", "gnomAD", "PubMed", "CIViC", "OncoKB", "Internal", "Other"]).notNull(),
    clinicalDomain: mysqlEnum("clinicalDomain", [
      "germline_classification",
      "oncogenicity",
      "therapeutic",
      "diagnostic",
      "prognostic",
      "population",
      "functional",
      "other",
    ]).default("other").notNull(),
    sourceRecordId: varchar("sourceRecordId", { length: 160 }),
    title: text("title").notNull(),
    url: varchar("url", { length: 1000 }),
    excerpt: text("excerpt").notNull(),
    direction: mysqlEnum("direction", ["supporting", "contradicting", "neutral"]).default("neutral").notNull(),
    evidenceLevel: varchar("evidenceLevel", { length: 80 }),
    payload: json("payload").$type<Record<string, unknown>>(),
    accessedAt: timestamp("accessedAt").defaultNow().notNull(),
    createdBy: int("createdBy").references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("evidence_variant_idx").on(table.organizationId, table.variantId),
    foreignKey({
      name: "evidence_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const interpretations = mysqlTable(
  "interpretations",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    variantId: int("variantId").notNull(),
    mode: mysqlEnum("mode", ["germline", "somatic"]).notNull(),
    germlineClassification: mysqlEnum("germlineClassification", [
      "Pathogenic",
      "Likely Pathogenic",
      "VUS",
      "Likely Benign",
      "Benign",
    ]),
    somaticTier: mysqlEnum("somaticTier", ["Tier I", "Tier II", "Tier III", "Tier IV"]),
    oncogenicity: mysqlEnum("oncogenicity", [
      "Oncogenic",
      "Likely Oncogenic",
      "VUS",
      "Likely Benign",
      "Benign",
    ]),
    clinicalSignificance: varchar("clinicalSignificance", { length: 160 }),
    diseaseContext: varchar("diseaseContext", { length: 255 }),
    rationale: text("rationale").notNull(),
    status: mysqlEnum("status", ["draft", "in_review", "approved"]).default("draft").notNull(),
    version: int("version").default(1).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    approvedBy: int("approvedBy").references(() => users.id),
    approvedAt: timestamp("approvedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("interpretations_org_variant_version_uq").on(table.organizationId, table.variantId, table.version),
    uniqueIndex("interpretations_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "interpretations_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const criteriaAssessments = mysqlTable(
  "criteria_assessments",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    interpretationId: int("interpretationId").notNull(),
    code: varchar("code", { length: 20 }).notNull(),
    state: mysqlEnum("state", ["met", "not_met", "not_applicable"]).notNull(),
    strengthOverride: varchar("strengthOverride", { length: 40 }),
    evidenceIds: json("evidenceIds").$type<number[]>().notNull(),
    note: text("note"),
    updatedBy: int("updatedBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("criteria_interp_code_uq").on(table.organizationId, table.interpretationId, table.code),
    foreignKey({
      name: "criteria_interpretation_org_fk",
      columns: [table.interpretationId, table.organizationId],
      foreignColumns: [interpretations.id, interpretations.organizationId],
    }).onDelete("cascade"),
  ]
);

export const aiConversations = mysqlTable(
  "ai_conversations",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    variantId: int("variantId").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    modelId: varchar("modelId", { length: 120 }).notNull(),
    createdBy: int("createdBy").notNull().references(() => users.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("ai_conversations_id_org_uq").on(table.id, table.organizationId),
    foreignKey({
      name: "ai_conversations_variant_org_fk",
      columns: [table.variantId, table.organizationId],
      foreignColumns: [variants.id, variants.organizationId],
    }).onDelete("cascade"),
  ]
);

export const aiMessages = mysqlTable(
  "ai_messages",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    conversationId: int("conversationId").notNull(),
    role: mysqlEnum("role", ["user", "assistant"]).notNull(),
    content: text("content").notNull(),
    citationIds: json("citationIds").$type<number[]>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("ai_messages_conversation_idx").on(table.organizationId, table.conversationId, table.createdAt),
    foreignKey({
      name: "ai_messages_conversation_org_fk",
      columns: [table.conversationId, table.organizationId],
      foreignColumns: [aiConversations.id, aiConversations.organizationId],
    }).onDelete("cascade"),
  ]
);

export const reports = mysqlTable(
  "reports",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    caseId: int("caseId").notNull(),
    version: int("version").notNull(),
    status: mysqlEnum("status", ["draft", "in_review", "signed", "amended"]).default("draft").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    content: json("content").$type<Record<string, unknown>>().notNull(),
    snapshot: json("snapshot").$type<Record<string, unknown>>(),
    snapshotHash: varchar("snapshotHash", { length: 64 }),
    parentReportId: int("parentReportId"),
    createdBy: int("createdBy").notNull().references(() => users.id),
    signedBy: int("signedBy").references(() => users.id),
    signedAt: timestamp("signedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("reports_org_case_version_uq").on(table.organizationId, table.caseId, table.version),
    uniqueIndex("reports_id_org_uq").on(table.id, table.organizationId),
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

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    organizationId: int("organizationId").notNull().references(() => organizations.id),
    actorUserId: int("actorUserId").references(() => users.id),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entityType", { length: 80 }).notNull(),
    entityId: varchar("entityId", { length: 80 }).notNull(),
    requestId: varchar("requestId", { length: 80 }).notNull(),
    before: json("before").$type<Record<string, unknown> | null>(),
    after: json("after").$type<Record<string, unknown> | null>(),
    ipAddress: varchar("ipAddress", { length: 64 }),
    userAgent: varchar("userAgent", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
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

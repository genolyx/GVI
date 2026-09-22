CREATE TYPE "public"."ai_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."analysis_job_status" AS ENUM('queued', 'running', 'review_ready', 'failed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."analysis_pipeline" AS ENUM('vcf_ingest', 'gx_exome', 'gx_somatic');--> statement-breakpoint
CREATE TYPE "public"."case_file_kind" AS ENUM('vcf', 'fastq_r1', 'fastq_r2', 'bam', 'bai', 'report', 'other');--> statement-breakpoint
CREATE TYPE "public"."case_file_status" AS ENUM('uploaded', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."case_input_type" AS ENUM('vcf', 'fastq');--> statement-breakpoint
CREATE TYPE "public"."case_purpose" AS ENUM('germline', 'somatic');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('draft', 'queued', 'running', 'review_ready', 'in_review', 'reported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."criterion_state" AS ENUM('met', 'not_met', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."evidence_clinical_domain" AS ENUM('germline_classification', 'oncogenicity', 'therapeutic', 'diagnostic', 'prognostic', 'population', 'functional', 'other');--> statement-breakpoint
CREATE TYPE "public"."evidence_direction" AS ENUM('supporting', 'contradicting', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."evidence_source" AS ENUM('ClinVar', 'OMIM', 'gnomAD', 'PubMed', 'CIViC', 'OncoKB', 'Internal', 'Other');--> statement-breakpoint
CREATE TYPE "public"."germline_classification" AS ENUM('Pathogenic', 'Likely Pathogenic', 'VUS', 'Likely Benign', 'Benign');--> statement-breakpoint
CREATE TYPE "public"."interpretation_mode" AS ENUM('germline', 'somatic');--> statement-breakpoint
CREATE TYPE "public"."interpretation_status" AS ENUM('draft', 'in_review', 'approved');--> statement-breakpoint
CREATE TYPE "public"."isolation_mode" AS ENUM('shared_schema', 'dedicated_database');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."oncogenicity_classification" AS ENUM('Oncogenic', 'Likely Oncogenic', 'VUS', 'Likely Benign', 'Benign');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('administrator', 'analyst', 'clinician', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."reference_build" AS ENUM('GRCh37', 'GRCh38');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('draft', 'in_review', 'signed', 'amended');--> statement-breakpoint
CREATE TYPE "public"."sample_role" AS ENUM('proband', 'mother', 'father', 'tumor', 'normal', 'other');--> statement-breakpoint
CREATE TYPE "public"."somatic_tier" AS ENUM('Tier I', 'Tier II', 'Tier III', 'Tier IV');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."variant_impact" AS ENUM('HIGH', 'MODERATE', 'LOW', 'MODIFIER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."variant_review_status" AS ENUM('unreviewed', 'reviewing', 'reviewed', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."variant_type" AS ENUM('SNV', 'INDEL', 'CNV', 'SV', 'FUSION', 'OTHER');--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"modelId" varchar(120) NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"conversationId" integer NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"content" text NOT NULL,
	"citationIds" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analysis_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"jobId" integer NOT NULL,
	"status" varchar(40) NOT NULL,
	"message" text NOT NULL,
	"progressPercent" integer NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analysis_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"pipeline" "analysis_pipeline" NOT NULL,
	"status" "analysis_job_status" DEFAULT 'queued' NOT NULL,
	"progressPercent" integer DEFAULT 0 NOT NULL,
	"externalJobId" varchar(160),
	"idempotencyKey" varchar(80) NOT NULL,
	"manifest" jsonb NOT NULL,
	"errorMessage" text,
	"createdBy" integer NOT NULL,
	"claimedAt" timestamp with time zone,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_jobs_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"actorUserId" integer,
	"action" varchar(120) NOT NULL,
	"entityType" varchar(80) NOT NULL,
	"entityId" varchar(80) NOT NULL,
	"requestId" varchar(80) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ipAddress" varchar(64),
	"userAgent" varchar(512),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "case_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"sampleId" integer,
	"kind" "case_file_kind" NOT NULL,
	"fileName" varchar(255) NOT NULL,
	"storageKey" varchar(512) NOT NULL,
	"storageUrl" varchar(768) NOT NULL,
	"mimeType" varchar(160) NOT NULL,
	"byteSize" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" "case_file_status" DEFAULT 'uploaded' NOT NULL,
	"uploadedBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"projectId" integer NOT NULL,
	"caseNumber" varchar(64) NOT NULL,
	"patientAlias" varchar(120) NOT NULL,
	"purpose" "case_purpose" NOT NULL,
	"inputType" "case_input_type" NOT NULL,
	"status" "case_status" DEFAULT 'draft' NOT NULL,
	"referenceBuild" "reference_build" NOT NULL,
	"panelName" varchar(160),
	"indication" text,
	"phenotypeText" text,
	"consentClinicalAnalysis" boolean NOT NULL,
	"consentSecondaryFindings" boolean DEFAULT false NOT NULL,
	"consentDataUse" boolean DEFAULT false NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "criteria_assessments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "criteria_assessments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"interpretationId" integer NOT NULL,
	"code" varchar(20) NOT NULL,
	"state" "criterion_state" NOT NULL,
	"strengthOverride" varchar(40),
	"evidenceIds" jsonb NOT NULL,
	"note" text,
	"updatedBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "evidence_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"source" "evidence_source" NOT NULL,
	"clinicalDomain" "evidence_clinical_domain" DEFAULT 'other' NOT NULL,
	"sourceRecordId" varchar(160),
	"title" text NOT NULL,
	"url" varchar(1000),
	"excerpt" text NOT NULL,
	"direction" "evidence_direction" DEFAULT 'neutral' NOT NULL,
	"evidenceLevel" varchar(80),
	"payload" jsonb,
	"accessedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "interpretations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"mode" "interpretation_mode" NOT NULL,
	"germlineClassification" "germline_classification",
	"somaticTier" "somatic_tier",
	"oncogenicity" "oncogenicity_classification",
	"clinicalSignificance" varchar(160),
	"diseaseContext" varchar(255),
	"rationale" text NOT NULL,
	"status" "interpretation_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"createdBy" integer NOT NULL,
	"approvedBy" integer,
	"approvedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interpretations_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organization_invites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" "organization_role" NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"acceptedAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organization_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"userId" integer NOT NULL,
	"role" "organization_role" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"invitedBy" integer,
	"joinedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(160) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"status" "organization_status" DEFAULT 'active' NOT NULL,
	"dataRegion" varchar(32) DEFAULT 'KR' NOT NULL,
	"isolationMode" "isolation_mode" DEFAULT 'shared_schema' NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"name" varchar(160) NOT NULL,
	"code" varchar(40) NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" jsonb NOT NULL,
	"snapshot" jsonb,
	"snapshotHash" varchar(64),
	"parentReportId" integer,
	"createdBy" integer NOT NULL,
	"signedBy" integer,
	"signedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"sampleCode" varchar(80) NOT NULL,
	"role" "sample_role" NOT NULL,
	"specimenType" varchar(100) NOT NULL,
	"tumorContentPercent" numeric(5, 2),
	"collectedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "samples_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"normalizedId" varchar(255) NOT NULL,
	"referenceBuild" "reference_build" NOT NULL,
	"chromosome" varchar(16) NOT NULL,
	"position" integer NOT NULL,
	"referenceAllele" text NOT NULL,
	"alternateAllele" text NOT NULL,
	"gene" varchar(80),
	"transcript" varchar(120),
	"hgvsC" varchar(255),
	"hgvsP" varchar(255),
	"consequence" varchar(160),
	"variantType" "variant_type" NOT NULL,
	"zygosity" varchar(40),
	"populationAf" numeric(12, 10),
	"vaf" numeric(12, 10),
	"readDepth" integer,
	"alternateDepth" integer,
	"impact" "variant_impact" DEFAULT 'UNKNOWN' NOT NULL,
	"clinvarSignificance" varchar(160),
	"reviewStatus" "variant_review_status" DEFAULT 'unreviewed' NOT NULL,
	"annotation" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_org_fk" FOREIGN KEY ("conversationId","organizationId") REFERENCES "public"."ai_conversations"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_events" ADD CONSTRAINT "analysis_events_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_events" ADD CONSTRAINT "analysis_events_job_org_fk" FOREIGN KEY ("jobId","organizationId") REFERENCES "public"."analysis_jobs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_users_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_files" ADD CONSTRAINT "case_files_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_files" ADD CONSTRAINT "case_files_uploadedBy_users_id_fk" FOREIGN KEY ("uploadedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_files" ADD CONSTRAINT "case_files_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_files" ADD CONSTRAINT "case_files_sample_org_fk" FOREIGN KEY ("sampleId","organizationId") REFERENCES "public"."samples"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_project_org_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."projects"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD CONSTRAINT "criteria_assessments_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD CONSTRAINT "criteria_assessments_updatedBy_users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD CONSTRAINT "criteria_interpretation_org_fk" FOREIGN KEY ("interpretationId","organizationId") REFERENCES "public"."interpretations"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_approvedBy_users_id_fk" FOREIGN KEY ("approvedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invitedBy_users_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_signedBy_users_id_fk" FOREIGN KEY ("signedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_parent_org_fk" FOREIGN KEY ("parentReportId","organizationId") REFERENCES "public"."reports"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("organizationId","conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "analysis_events_job_idx" ON "analysis_events" USING btree ("organizationId","jobId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_jobs_idempotency_uq" ON "analysis_jobs" USING btree ("idempotencyKey");--> statement-breakpoint
CREATE INDEX "analysis_jobs_org_status_idx" ON "analysis_jobs" USING btree ("organizationId","status");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("organizationId","createdAt");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("organizationId","entityType","entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "case_files_org_storage_uq" ON "case_files" USING btree ("organizationId","storageKey");--> statement-breakpoint
CREATE INDEX "case_files_case_idx" ON "case_files" USING btree ("organizationId","caseId");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_org_number_uq" ON "cases" USING btree ("organizationId","caseNumber");--> statement-breakpoint
CREATE INDEX "cases_org_status_idx" ON "cases" USING btree ("organizationId","status");--> statement-breakpoint
CREATE INDEX "cases_project_idx" ON "cases" USING btree ("organizationId","projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "criteria_interp_code_uq" ON "criteria_assessments" USING btree ("organizationId","interpretationId","code");--> statement-breakpoint
CREATE INDEX "evidence_variant_idx" ON "evidence_items" USING btree ("organizationId","variantId");--> statement-breakpoint
CREATE UNIQUE INDEX "interpretations_org_variant_version_uq" ON "interpretations" USING btree ("organizationId","variantId","version");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invites_token_uq" ON "organization_invites" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "organization_invites_org_email_idx" ON "organization_invites" USING btree ("organizationId","email");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_uq" ON "organization_members" USING btree ("organizationId","userId");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("userId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_code_uq" ON "projects" USING btree ("organizationId","code");--> statement-breakpoint
CREATE INDEX "projects_org_status_idx" ON "projects" USING btree ("organizationId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_org_case_version_uq" ON "reports" USING btree ("organizationId","caseId","version");--> statement-breakpoint
CREATE UNIQUE INDEX "samples_org_case_code_uq" ON "samples" USING btree ("organizationId","caseId","sampleCode");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_org_case_normalized_uq" ON "variants" USING btree ("organizationId","caseId","normalizedId");--> statement-breakpoint
CREATE INDEX "variants_workbench_idx" ON "variants" USING btree ("organizationId","caseId","gene","impact");
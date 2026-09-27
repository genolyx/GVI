CREATE TYPE "public"."amp_level" AS ENUM('A', 'B', 'C', 'D');--> statement-breakpoint
CREATE TYPE "public"."disease_match" AS ENUM('exact', 'broader', 'narrower', 'manual', 'none', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."somatic_assertion_status" AS ENUM('proposed', 'in_review', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."somatic_clinical_effect" AS ENUM('sensitivity', 'resistance', 'no_response', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."somatic_normalization_status" AS ENUM('pending', 'normalized', 'failed');--> statement-breakpoint
CREATE TYPE "public"."somatic_qc_status" AS ENUM('pass', 'low_depth', 'low_vaf', 'filtered', 'manual_review_required', 'indeterminate');--> statement-breakpoint
CREATE TYPE "public"."somatic_report_template_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."somatic_run_status" AS ENUM('queued', 'validating', 'normalizing', 'annotating', 'ready_for_review', 'partial', 'failed');--> statement-breakpoint
ALTER TYPE "public"."oncogenicity_classification" ADD VALUE 'Not Evaluated';--> statement-breakpoint
CREATE TABLE "somatic_case_contexts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_case_contexts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"primaryTumorTypeId" integer NOT NULL,
	"panelVersionId" integer NOT NULL,
	"histologyText" varchar(255),
	"diseaseStatus" varchar(80),
	"specimenCollectionSite" varchar(160) NOT NULL,
	"pairedNormal" boolean DEFAULT false NOT NULL,
	"mappingProvenance" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_case_contexts_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_case_contexts_case_uq" UNIQUE("organizationId","caseId")
);
--> statement-breakpoint
CREATE TABLE "somatic_clinical_assertions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_clinical_assertions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"runId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"tumorTypeId" integer NOT NULL,
	"regimenId" integer,
	"clinicalDomain" "evidence_clinical_domain" NOT NULL,
	"clinicalEffect" "somatic_clinical_effect",
	"systemTier" "somatic_tier",
	"systemLevel" "amp_level",
	"finalTier" "somatic_tier",
	"finalLevel" "amp_level",
	"oncogenicity" "oncogenicity_classification",
	"status" "somatic_assertion_status" DEFAULT 'proposed' NOT NULL,
	"rulesetVersion" varchar(80) NOT NULL,
	"rationale" text NOT NULL,
	"evidenceIds" jsonb NOT NULL,
	"overrideReason" text,
	"reviewedBy" integer,
	"reviewedAt" timestamp with time zone,
	"supersedesAssertionId" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_clinical_assertions_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "somatic_evidence_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_evidence_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"runId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"tumorTypeId" integer,
	"regimenId" integer,
	"sourceName" varchar(80) NOT NULL,
	"sourceVersion" varchar(120) NOT NULL,
	"sourceRecordId" varchar(200) NOT NULL,
	"sourceNativeLevel" varchar(80),
	"clinicalDomain" "evidence_clinical_domain" NOT NULL,
	"clinicalEffect" "somatic_clinical_effect",
	"direction" "evidence_direction" DEFAULT 'neutral' NOT NULL,
	"diseaseMatch" "disease_match" DEFAULT 'unknown' NOT NULL,
	"summary" text NOT NULL,
	"sourceUrl" varchar(1000),
	"citation" varchar(500),
	"rawResponseHash" varchar(64) NOT NULL,
	"retrievedAt" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_evidence_records_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_evidence_records_source_record_uq" UNIQUE("organizationId","runId","sourceName","sourceVersion","sourceRecordId")
);
--> statement-breakpoint
CREATE TABLE "somatic_interpretation_run_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_interpretation_run_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"runId" integer NOT NULL,
	"status" "somatic_run_status" NOT NULL,
	"message" text NOT NULL,
	"progressPercent" integer NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "somatic_interpretation_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_interpretation_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer NOT NULL,
	"contextId" integer NOT NULL,
	"status" "somatic_run_status" DEFAULT 'queued' NOT NULL,
	"pipelineVersion" varchar(80) NOT NULL,
	"rulesetVersion" varchar(80) NOT NULL,
	"knowledgeVersions" jsonb NOT NULL,
	"error" jsonb,
	"requestedBy" integer NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_interpretation_runs_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
CREATE TABLE "somatic_panel_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_panel_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"panelId" integer NOT NULL,
	"version" varchar(80) NOT NULL,
	"genomeBuild" "reference_build" NOT NULL,
	"assayType" varchar(120) NOT NULL,
	"capabilities" jsonb NOT NULL,
	"limitations" text,
	"activeFrom" timestamp with time zone,
	"activeTo" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_panel_versions_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_panel_versions_panel_version_uq" UNIQUE("organizationId","panelId","version")
);
--> statement-breakpoint
CREATE TABLE "somatic_panels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_panels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"manufacturer" varchar(160) NOT NULL,
	"name" varchar(200) NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_panels_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_panels_org_manufacturer_name_uq" UNIQUE("organizationId","manufacturer","name")
);
--> statement-breakpoint
CREATE TABLE "somatic_regimen_therapies" (
	"regimenId" integer NOT NULL,
	"therapyId" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "somatic_regimen_therapies_regimen_therapy_uq" UNIQUE("regimenId","therapyId")
);
--> statement-breakpoint
CREATE TABLE "somatic_regimens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_regimens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(320) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_regimens_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "somatic_report_template_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_report_template_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"templateId" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "somatic_report_template_status" DEFAULT 'draft' NOT NULL,
	"schema" jsonb NOT NULL,
	"createdBy" integer NOT NULL,
	"publishedBy" integer,
	"publishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_report_template_versions_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_report_template_versions_template_version_uq" UNIQUE("organizationId","templateId","version")
);
--> statement-breakpoint
CREATE TABLE "somatic_report_templates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_report_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"activeVersionId" integer,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_report_templates_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_report_templates_org_name_uq" UNIQUE("organizationId","name")
);
--> statement-breakpoint
CREATE TABLE "somatic_therapies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_therapies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"genericName" varchar(200) NOT NULL,
	"brandName" varchar(200),
	"drugClass" varchar(160),
	"externalIdentifiers" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_therapies_generic_name_uq" UNIQUE("genericName")
);
--> statement-breakpoint
CREATE TABLE "somatic_tumor_types" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_tumor_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ontologySystem" varchar(40) NOT NULL,
	"ontologyVersion" varchar(80) NOT NULL,
	"code" varchar(80) NOT NULL,
	"label" varchar(255) NOT NULL,
	"primarySite" varchar(160),
	"histology" varchar(160),
	"parentId" integer,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_tumor_types_system_version_code_uq" UNIQUE("ontologySystem","ontologyVersion","code")
);
--> statement-breakpoint
CREATE TABLE "somatic_variant_analyses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "somatic_variant_analyses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"runId" integer NOT NULL,
	"variantId" integer NOT NULL,
	"normalizationStatus" "somatic_normalization_status" DEFAULT 'pending' NOT NULL,
	"normalizationError" text,
	"originalRepresentation" jsonb,
	"normalizedRepresentation" jsonb,
	"transcriptPolicy" varchar(80),
	"qcStatus" "somatic_qc_status" DEFAULT 'indeterminate' NOT NULL,
	"qcReasons" jsonb NOT NULL,
	"candidate" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "somatic_variant_analyses_id_org_uq" UNIQUE("id","organizationId"),
	CONSTRAINT "somatic_variant_analyses_run_variant_uq" UNIQUE("organizationId","runId","variantId")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "somaticTemplateVersionId" integer;--> statement-breakpoint
ALTER TABLE "somatic_case_contexts" ADD CONSTRAINT "somatic_case_contexts_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_case_contexts" ADD CONSTRAINT "somatic_case_contexts_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_case_contexts" ADD CONSTRAINT "somatic_case_contexts_tumor_type_fk" FOREIGN KEY ("primaryTumorTypeId") REFERENCES "public"."somatic_tumor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_case_contexts" ADD CONSTRAINT "somatic_case_contexts_panel_version_org_fk" FOREIGN KEY ("panelVersionId","organizationId") REFERENCES "public"."somatic_panel_versions"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_regimenId_somatic_regimens_id_fk" FOREIGN KEY ("regimenId") REFERENCES "public"."somatic_regimens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_reviewedBy_users_id_fk" FOREIGN KEY ("reviewedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_run_org_fk" FOREIGN KEY ("runId","organizationId") REFERENCES "public"."somatic_interpretation_runs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_tumor_type_fk" FOREIGN KEY ("tumorTypeId") REFERENCES "public"."somatic_tumor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_clinical_assertions" ADD CONSTRAINT "somatic_clinical_assertions_supersedes_org_fk" FOREIGN KEY ("supersedesAssertionId","organizationId") REFERENCES "public"."somatic_clinical_assertions"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_evidence_records" ADD CONSTRAINT "somatic_evidence_records_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_evidence_records" ADD CONSTRAINT "somatic_evidence_records_regimenId_somatic_regimens_id_fk" FOREIGN KEY ("regimenId") REFERENCES "public"."somatic_regimens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_evidence_records" ADD CONSTRAINT "somatic_evidence_records_run_org_fk" FOREIGN KEY ("runId","organizationId") REFERENCES "public"."somatic_interpretation_runs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_evidence_records" ADD CONSTRAINT "somatic_evidence_records_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_evidence_records" ADD CONSTRAINT "somatic_evidence_records_tumor_type_fk" FOREIGN KEY ("tumorTypeId") REFERENCES "public"."somatic_tumor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_run_events" ADD CONSTRAINT "somatic_interpretation_run_events_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_run_events" ADD CONSTRAINT "somatic_interpretation_run_events_run_org_fk" FOREIGN KEY ("runId","organizationId") REFERENCES "public"."somatic_interpretation_runs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_runs" ADD CONSTRAINT "somatic_interpretation_runs_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_runs" ADD CONSTRAINT "somatic_interpretation_runs_requestedBy_users_id_fk" FOREIGN KEY ("requestedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_runs" ADD CONSTRAINT "somatic_interpretation_runs_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_interpretation_runs" ADD CONSTRAINT "somatic_interpretation_runs_context_org_fk" FOREIGN KEY ("contextId","organizationId") REFERENCES "public"."somatic_case_contexts"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_panel_versions" ADD CONSTRAINT "somatic_panel_versions_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_panel_versions" ADD CONSTRAINT "somatic_panel_versions_panel_org_fk" FOREIGN KEY ("panelId","organizationId") REFERENCES "public"."somatic_panels"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_panels" ADD CONSTRAINT "somatic_panels_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_panels" ADD CONSTRAINT "somatic_panels_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_regimen_therapies" ADD CONSTRAINT "somatic_regimen_therapies_regimenId_somatic_regimens_id_fk" FOREIGN KEY ("regimenId") REFERENCES "public"."somatic_regimens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_regimen_therapies" ADD CONSTRAINT "somatic_regimen_therapies_therapyId_somatic_therapies_id_fk" FOREIGN KEY ("therapyId") REFERENCES "public"."somatic_therapies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_template_versions" ADD CONSTRAINT "somatic_report_template_versions_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_template_versions" ADD CONSTRAINT "somatic_report_template_versions_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_template_versions" ADD CONSTRAINT "somatic_report_template_versions_publishedBy_users_id_fk" FOREIGN KEY ("publishedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_template_versions" ADD CONSTRAINT "somatic_report_template_versions_template_org_fk" FOREIGN KEY ("templateId","organizationId") REFERENCES "public"."somatic_report_templates"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_templates" ADD CONSTRAINT "somatic_report_templates_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_report_templates" ADD CONSTRAINT "somatic_report_templates_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_tumor_types" ADD CONSTRAINT "somatic_tumor_types_parent_fk" FOREIGN KEY ("parentId") REFERENCES "public"."somatic_tumor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_variant_analyses" ADD CONSTRAINT "somatic_variant_analyses_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_variant_analyses" ADD CONSTRAINT "somatic_variant_analyses_run_org_fk" FOREIGN KEY ("runId","organizationId") REFERENCES "public"."somatic_interpretation_runs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "somatic_variant_analyses" ADD CONSTRAINT "somatic_variant_analyses_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "somatic_clinical_assertions_variant_idx" ON "somatic_clinical_assertions" USING btree ("organizationId","variantId","status");--> statement-breakpoint
CREATE INDEX "somatic_evidence_records_variant_idx" ON "somatic_evidence_records" USING btree ("organizationId","variantId","clinicalDomain");--> statement-breakpoint
CREATE INDEX "somatic_interpretation_run_events_run_idx" ON "somatic_interpretation_run_events" USING btree ("organizationId","runId","createdAt");--> statement-breakpoint
CREATE INDEX "somatic_interpretation_runs_case_idx" ON "somatic_interpretation_runs" USING btree ("organizationId","caseId","createdAt");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_somatic_template_version_org_fk" FOREIGN KEY ("somaticTemplateVersionId","organizationId") REFERENCES "public"."somatic_report_template_versions"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DO $$
DECLARE
	target_table text;
BEGIN
	FOREACH target_table IN ARRAY ARRAY[
		'somatic_panels',
		'somatic_panel_versions',
		'somatic_case_contexts',
		'somatic_interpretation_runs',
		'somatic_variant_analyses',
		'somatic_therapies',
		'somatic_regimens',
		'somatic_clinical_assertions',
		'somatic_report_templates'
	]
	LOOP
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
			target_table || '_set_updated_at',
			target_table
		);
	END LOOP;
END;
$$;
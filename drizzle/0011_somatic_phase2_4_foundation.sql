CREATE TYPE "public"."somatic_lifecycle_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."somatic_validation_status" AS ENUM('pending', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."somatic_license_status" AS ENUM('unconfigured', 'approved', 'restricted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."somatic_region_type" AS ENUM('gene', 'exon', 'interval', 'fusion_pair', 'signature');--> statement-breakpoint
CREATE TYPE "public"."somatic_finding_type" AS ENUM('CNV', 'FUSION', 'MSI', 'TMB', 'HRD');--> statement-breakpoint
CREATE TYPE "public"."somatic_finding_status" AS ENUM('detected', 'not_detected', 'not_tested', 'indeterminate');--> statement-breakpoint
CREATE TYPE "public"."somatic_task_status" AS ENUM('open', 'in_review', 'completed', 'dismissed');--> statement-breakpoint

CREATE TABLE "somatic_knowledge_providers" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "code" varchar(80) NOT NULL,
  "name" varchar(200) NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "licenseStatus" "somatic_license_status" DEFAULT 'unconfigured' NOT NULL,
  "licenseReference" varchar(500),
  "licenseValidFrom" timestamp with time zone,
  "licenseValidTo" timestamp with time zone,
  "licenseApprovedBy" integer,
  "licenseApprovedAt" timestamp with time zone,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_knowledge_providers_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_knowledge_providers_org_code_uq" UNIQUE("organizationId", "code"),
  CONSTRAINT "somatic_knowledge_providers_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_knowledge_providers_license_approver_fk" FOREIGN KEY ("licenseApprovedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_knowledge_providers_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "users"("id")
);--> statement-breakpoint

CREATE TABLE "somatic_knowledge_releases" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "providerId" integer NOT NULL,
  "version" varchar(120) NOT NULL,
  "status" "somatic_lifecycle_status" DEFAULT 'draft' NOT NULL,
  "validationStatus" "somatic_validation_status" DEFAULT 'pending' NOT NULL,
  "validationSummary" jsonb,
  "contentHash" varchar(64) NOT NULL,
  "sourcePublishedAt" timestamp with time zone,
  "importedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "validatedBy" integer,
  "validatedAt" timestamp with time zone,
  "activatedBy" integer,
  "activatedAt" timestamp with time zone,
  "retiredBy" integer,
  "retiredAt" timestamp with time zone,
  "changeControlId" varchar(120) NOT NULL,
  "changeSummary" text NOT NULL,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_knowledge_releases_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_knowledge_releases_provider_version_uq" UNIQUE("organizationId", "providerId", "version"),
  CONSTRAINT "somatic_knowledge_releases_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_knowledge_releases_provider_org_fk" FOREIGN KEY ("providerId", "organizationId") REFERENCES "somatic_knowledge_providers"("id", "organizationId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_knowledge_releases_validator_fk" FOREIGN KEY ("validatedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_knowledge_releases_activator_fk" FOREIGN KEY ("activatedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_knowledge_releases_retirer_fk" FOREIGN KEY ("retiredBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_knowledge_releases_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_knowledge_releases_activation_ck" CHECK ("status" <> 'active' OR ("validationStatus" = 'passed' AND "validatedBy" IS NOT NULL AND "validatedAt" IS NOT NULL AND "activatedBy" IS NOT NULL AND "activatedAt" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "somatic_guideline_records" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "recordKey" varchar(200) NOT NULL,
  "recordVersion" integer DEFAULT 1 NOT NULL,
  "title" varchar(500) NOT NULL,
  "guideline" jsonb NOT NULL,
  "sourceCitation" varchar(1000) NOT NULL,
  "effectiveFrom" timestamp with time zone,
  "effectiveTo" timestamp with time zone,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_guideline_records_release_key_version_uq" UNIQUE("organizationId", "releaseId", "recordKey", "recordVersion"),
  CONSTRAINT "somatic_guideline_records_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_guideline_records_release_org_fk" FOREIGN KEY ("releaseId", "organizationId") REFERENCES "somatic_knowledge_releases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_guideline_records_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "users"("id")
);--> statement-breakpoint

CREATE TABLE "somatic_panel_reportable_regions" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "panelVersionId" integer NOT NULL,
  "regionKey" varchar(240) NOT NULL,
  "regionType" "somatic_region_type" NOT NULL,
  "findingType" "somatic_finding_type",
  "gene" varchar(80),
  "transcript" varchar(120),
  "chromosome" varchar(16),
  "start" integer,
  "end" integer,
  "target" jsonb,
  "minimumDepth" integer,
  "minimumCoveragePercent" numeric(5,2),
  "reportable" boolean DEFAULT true NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_panel_regions_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_panel_regions_version_key_uq" UNIQUE("organizationId", "panelVersionId", "regionKey"),
  CONSTRAINT "somatic_panel_regions_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_panel_regions_version_org_fk" FOREIGN KEY ("panelVersionId", "organizationId") REFERENCES "somatic_panel_versions"("id", "organizationId") ON DELETE CASCADE
);--> statement-breakpoint

CREATE TABLE "somatic_case_coverage_summaries" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "caseId" integer NOT NULL,
  "panelVersionId" integer NOT NULL,
  "validationStatus" "somatic_validation_status" DEFAULT 'pending' NOT NULL,
  "completeRegionCount" integer DEFAULT 0 NOT NULL,
  "expectedRegionCount" integer DEFAULT 0 NOT NULL,
  "qcMetrics" jsonb NOT NULL,
  "validationHash" varchar(64),
  "validatedBy" integer,
  "validatedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_case_coverage_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_case_coverage_identity_uq" UNIQUE("id", "organizationId", "caseId", "panelVersionId"),
  CONSTRAINT "somatic_case_coverage_case_panel_uq" UNIQUE("organizationId", "caseId", "panelVersionId"),
  CONSTRAINT "somatic_case_coverage_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_case_coverage_case_org_fk" FOREIGN KEY ("caseId", "organizationId") REFERENCES "cases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_case_coverage_panel_org_fk" FOREIGN KEY ("panelVersionId", "organizationId") REFERENCES "somatic_panel_versions"("id", "organizationId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_case_coverage_validator_fk" FOREIGN KEY ("validatedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_case_coverage_validation_ck" CHECK ("validationStatus" <> 'passed' OR ("expectedRegionCount" > 0 AND "completeRegionCount" = "expectedRegionCount" AND "validationHash" IS NOT NULL AND "validatedBy" IS NOT NULL AND "validatedAt" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "somatic_case_region_coverage" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "coverageSummaryId" integer NOT NULL,
  "panelRegionId" integer NOT NULL,
  "meanDepth" numeric(12,2),
  "coveredPercent" numeric(5,2),
  "qcPassed" boolean NOT NULL,
  "qcReasons" jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_case_region_coverage_summary_region_uq" UNIQUE("organizationId", "coverageSummaryId", "panelRegionId"),
  CONSTRAINT "somatic_case_region_coverage_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_case_region_coverage_summary_org_fk" FOREIGN KEY ("coverageSummaryId", "organizationId") REFERENCES "somatic_case_coverage_summaries"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_case_region_coverage_region_org_fk" FOREIGN KEY ("panelRegionId", "organizationId") REFERENCES "somatic_panel_reportable_regions"("id", "organizationId") ON DELETE RESTRICT
);--> statement-breakpoint

CREATE TABLE "somatic_assay_findings" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "caseId" integer NOT NULL,
  "panelVersionId" integer NOT NULL,
  "coverageSummaryId" integer,
  "findingType" "somatic_finding_type" NOT NULL,
  "status" "somatic_finding_status" NOT NULL,
  "result" jsonb,
  "reportable" boolean DEFAULT false NOT NULL,
  "reportabilityReasons" jsonb NOT NULL,
  "sourceRunId" varchar(160),
  "reviewedBy" integer,
  "reviewedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_assay_findings_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_assay_findings_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_assay_findings_case_org_fk" FOREIGN KEY ("caseId", "organizationId") REFERENCES "cases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_assay_findings_panel_org_fk" FOREIGN KEY ("panelVersionId", "organizationId") REFERENCES "somatic_panel_versions"("id", "organizationId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_assay_findings_coverage_org_fk" FOREIGN KEY ("coverageSummaryId", "organizationId", "caseId", "panelVersionId") REFERENCES "somatic_case_coverage_summaries"("id", "organizationId", "caseId", "panelVersionId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_assay_findings_reviewer_fk" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_assay_findings_negative_reportable_ck" CHECK (NOT "reportable" OR "status" NOT IN ('not_detected', 'not_tested') OR "coverageSummaryId" IS NOT NULL),
  CONSTRAINT "somatic_assay_findings_result_type_ck" CHECK ("result" IS NULL OR "result"->>'type' = "findingType"::text)
);--> statement-breakpoint

CREATE TABLE "somatic_organization_policy_profiles" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "name" varchar(160) NOT NULL,
  "version" integer NOT NULL,
  "status" "somatic_lifecycle_status" DEFAULT 'draft' NOT NULL,
  "allowNegativeReporting" boolean DEFAULT false NOT NULL,
  "enableOncoKb" boolean DEFAULT false NOT NULL,
  "policy" jsonb NOT NULL,
  "contentHash" varchar(64) NOT NULL,
  "changeControlId" varchar(120) NOT NULL,
  "approvedBy" integer,
  "approvedAt" timestamp with time zone,
  "activatedBy" integer,
  "activatedAt" timestamp with time zone,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_policy_profiles_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_policy_profiles_org_name_version_uq" UNIQUE("organizationId", "name", "version"),
  CONSTRAINT "somatic_policy_profiles_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_policy_profiles_approver_fk" FOREIGN KEY ("approvedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_policy_profiles_activator_fk" FOREIGN KEY ("activatedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_policy_profiles_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_policy_profiles_activation_ck" CHECK ("status" <> 'active' OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL AND "activatedBy" IS NOT NULL AND "activatedAt" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "somatic_reinterpretation_tasks" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "caseId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "findingId" integer,
  "status" "somatic_task_status" DEFAULT 'open' NOT NULL,
  "reason" text NOT NULL,
  "impact" jsonb NOT NULL,
  "previousReleaseVersion" varchar(120),
  "targetReleaseVersion" varchar(120) NOT NULL,
  "assignedTo" integer,
  "completedBy" integer,
  "completedAt" timestamp with time zone,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_reinterpretation_tasks_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_reinterpretation_tasks_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_reinterpretation_tasks_case_org_fk" FOREIGN KEY ("caseId", "organizationId") REFERENCES "cases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_reinterpretation_tasks_release_org_fk" FOREIGN KEY ("releaseId", "organizationId") REFERENCES "somatic_knowledge_releases"("id", "organizationId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_reinterpretation_tasks_finding_org_fk" FOREIGN KEY ("findingId", "organizationId") REFERENCES "somatic_assay_findings"("id", "organizationId") ON DELETE RESTRICT,
  CONSTRAINT "somatic_reinterpretation_tasks_assignee_fk" FOREIGN KEY ("assignedTo") REFERENCES "users"("id"),
  CONSTRAINT "somatic_reinterpretation_tasks_completer_fk" FOREIGN KEY ("completedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_reinterpretation_tasks_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "users"("id")
);--> statement-breakpoint

CREATE INDEX "somatic_knowledge_providers_org_enabled_idx" ON "somatic_knowledge_providers" ("organizationId", "enabled");--> statement-breakpoint
CREATE INDEX "somatic_knowledge_releases_org_status_idx" ON "somatic_knowledge_releases" ("organizationId", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "somatic_knowledge_releases_one_active_uq" ON "somatic_knowledge_releases" ("organizationId", "providerId") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "somatic_assay_findings_case_type_idx" ON "somatic_assay_findings" ("organizationId", "caseId", "findingType");--> statement-breakpoint
CREATE UNIQUE INDEX "somatic_policy_profiles_one_active_uq" ON "somatic_organization_policy_profiles" ("organizationId") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "somatic_reinterpretation_tasks_queue_idx" ON "somatic_reinterpretation_tasks" ("organizationId", "status", "createdAt");--> statement-breakpoint

DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'somatic_knowledge_providers',
    'somatic_knowledge_releases',
    'somatic_panel_reportable_regions',
    'somatic_case_coverage_summaries',
    'somatic_assay_findings',
    'somatic_organization_policy_profiles',
    'somatic_reinterpretation_tasks'
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

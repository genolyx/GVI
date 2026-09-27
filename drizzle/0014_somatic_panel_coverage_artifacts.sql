ALTER TABLE "somatic_panel_versions"
ADD COLUMN "regionArtifactName" varchar(255),
ADD COLUMN "regionArtifactHash" varchar(64),
ADD COLUMN "regionValidationStatus" "somatic_validation_status" DEFAULT 'pending' NOT NULL,
ADD COLUMN "regionValidatedBy" integer,
ADD COLUMN "regionValidatedAt" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "somatic_panel_versions"
ADD CONSTRAINT "somatic_panel_versions_region_validated_by_fk"
FOREIGN KEY ("regionValidatedBy") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "somatic_panel_versions"
ADD CONSTRAINT "somatic_panel_versions_region_validation_ck"
CHECK (
  "regionValidationStatus" <> 'passed'
  OR (
    "regionArtifactHash" ~ '^[0-9a-f]{64}$'
    AND "regionValidatedBy" IS NOT NULL
    AND "regionValidatedAt" IS NOT NULL
  )
);--> statement-breakpoint

ALTER TABLE "somatic_case_coverage_summaries"
ADD COLUMN "sourceArtifactHash" varchar(64);--> statement-breakpoint

ALTER TABLE "somatic_case_coverage_summaries"
ADD CONSTRAINT "somatic_case_coverage_source_hash_ck"
CHECK (
  "sourceArtifactHash" IS NULL
  OR "sourceArtifactHash" ~ '^[0-9a-f]{64}$'
);

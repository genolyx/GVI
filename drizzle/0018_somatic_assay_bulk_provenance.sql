ALTER TABLE "case_files"
ADD CONSTRAINT "case_files_id_org_case_uq"
UNIQUE ("id", "organizationId", "caseId");--> statement-breakpoint

ALTER TABLE "somatic_assay_findings"
ADD COLUMN "sourceArtifactFileId" integer,
ADD COLUMN "sourceArtifactHash" varchar(64);--> statement-breakpoint

ALTER TABLE "somatic_assay_findings"
ADD CONSTRAINT "somatic_assay_findings_artifact_org_case_fk"
FOREIGN KEY ("sourceArtifactFileId", "organizationId", "caseId")
REFERENCES "case_files"("id", "organizationId", "caseId")
ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "somatic_assay_findings"
ADD CONSTRAINT "somatic_assay_findings_artifact_hash_ck"
CHECK (
  ("sourceArtifactFileId" IS NULL AND "sourceArtifactHash" IS NULL)
  OR (
    "sourceArtifactFileId" IS NOT NULL
    AND "sourceArtifactHash" ~ '^[0-9a-f]{64}$'
  )
);

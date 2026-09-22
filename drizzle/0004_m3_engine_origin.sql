CREATE TYPE "public"."evidence_origin" AS ENUM('engine', 'human', 'human_confirmed');--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'HGMD' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'ClinGen' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'SpliceAI' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'Pangolin' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'MetaDome' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'UniProt' BEFORE 'Internal';--> statement-breakpoint
ALTER TYPE "public"."evidence_source" ADD VALUE 'Ensembl' BEFORE 'Internal';--> statement-breakpoint
ALTER TABLE "criteria_assessments" ALTER COLUMN "updatedBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interpretations" ALTER COLUMN "createdBy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD COLUMN "origin" "evidence_origin" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD COLUMN "curationRunId" integer;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "origin" "evidence_origin" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "curationRunId" integer;--> statement-breakpoint
ALTER TABLE "interpretations" ADD COLUMN "origin" "evidence_origin" DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "criteria_assessments" ADD CONSTRAINT "criteria_curation_run_org_fk" FOREIGN KEY ("curationRunId","organizationId") REFERENCES "public"."curation_runs"("id","organizationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_curation_run_org_fk" FOREIGN KEY ("curationRunId","organizationId") REFERENCES "public"."curation_runs"("id","organizationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_curation_run_idx" ON "evidence_items" USING btree ("organizationId","curationRunId");
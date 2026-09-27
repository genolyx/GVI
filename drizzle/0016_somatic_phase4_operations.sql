CREATE UNIQUE INDEX "somatic_interpretation_runs_one_active_case_uq"
ON "somatic_interpretation_runs" ("organizationId", "caseId")
WHERE "status" IN ('queued', 'validating', 'normalizing', 'annotating');--> statement-breakpoint

ALTER TABLE "somatic_reinterpretation_tasks"
ADD COLUMN "interpretationRunId" integer,
ADD COLUMN "enqueuedBy" integer,
ADD COLUMN "enqueuedAt" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "somatic_reinterpretation_tasks"
ADD CONSTRAINT "somatic_reinterpretation_tasks_enqueuedBy_users_id_fk"
FOREIGN KEY ("enqueuedBy") REFERENCES "users"("id");--> statement-breakpoint

ALTER TABLE "somatic_reinterpretation_tasks"
ADD CONSTRAINT "somatic_reinterpretation_tasks_run_org_fk"
FOREIGN KEY ("interpretationRunId", "organizationId")
REFERENCES "somatic_interpretation_runs"("id", "organizationId")
ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "somatic_reinterpretation_tasks_one_open_case_release_uq"
ON "somatic_reinterpretation_tasks" ("organizationId", "caseId", "releaseId")
WHERE "status" IN ('open', 'in_review');

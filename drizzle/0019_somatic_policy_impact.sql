ALTER TABLE "somatic_reinterpretation_tasks"
ADD COLUMN "changeKind" varchar(40) DEFAULT 'knowledge_release' NOT NULL,
ADD COLUMN "changeKey" varchar(200);--> statement-breakpoint

DROP INDEX "somatic_reinterpretation_tasks_one_open_case_release_uq";--> statement-breakpoint

CREATE UNIQUE INDEX "somatic_reinterpretation_tasks_one_open_change_uq"
ON "somatic_reinterpretation_tasks" (
  "organizationId",
  "caseId",
  COALESCE("changeKey", 'release:' || "releaseId"::text)
)
WHERE "status" IN ('open', 'in_review');

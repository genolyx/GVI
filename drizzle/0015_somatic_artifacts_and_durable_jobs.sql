ALTER TYPE "case_file_kind" ADD VALUE IF NOT EXISTS 'panel_bed';--> statement-breakpoint
ALTER TYPE "case_file_kind" ADD VALUE IF NOT EXISTS 'coverage';--> statement-breakpoint
ALTER TYPE "case_file_kind" ADD VALUE IF NOT EXISTS 'assay_result';--> statement-breakpoint

ALTER TABLE "somatic_interpretation_runs"
ADD COLUMN "attemptCount" integer DEFAULT 0 NOT NULL,
ADD COLUMN "maxAttempts" integer DEFAULT 3 NOT NULL,
ADD COLUMN "availableAt" timestamp with time zone DEFAULT now() NOT NULL,
ADD COLUMN "leaseOwner" varchar(160),
ADD COLUMN "leaseExpiresAt" timestamp with time zone,
ADD COLUMN "lastError" text;--> statement-breakpoint

ALTER TABLE "somatic_interpretation_runs"
ADD CONSTRAINT "somatic_interpretation_runs_attempts_ck"
CHECK (
  "attemptCount" >= 0
  AND "maxAttempts" BETWEEN 1 AND 10
  AND "attemptCount" <= "maxAttempts"
);--> statement-breakpoint

CREATE INDEX "somatic_interpretation_runs_worker_idx"
ON "somatic_interpretation_runs" ("status", "availableAt", "leaseExpiresAt");

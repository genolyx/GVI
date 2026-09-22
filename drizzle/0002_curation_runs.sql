CREATE TYPE "public"."curation_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "curation_run_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "curation_run_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"runId" integer NOT NULL,
	"status" varchar(40) NOT NULL,
	"message" text NOT NULL,
	"progressPercent" integer NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curation_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "curation_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"organizationId" integer NOT NULL,
	"caseId" integer,
	"variantId" integer,
	"status" "curation_run_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"input" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"leaseExpiresAt" timestamp with time zone,
	"workerId" varchar(120),
	"heartbeatAt" timestamp with time zone,
	"documentKey" varchar(512),
	"documentHash" varchar(64),
	"rawKey" varchar(512),
	"rawHash" varchar(64),
	"summary" jsonb,
	"engineVersion" varchar(40),
	"contractVersion" varchar(16),
	"error" jsonb,
	"timings" jsonb,
	"requestedBy" integer,
	"queuedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curation_runs_id_org_uq" UNIQUE("id","organizationId")
);
--> statement-breakpoint
ALTER TABLE "curation_run_events" ADD CONSTRAINT "curation_run_events_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_run_events" ADD CONSTRAINT "curation_run_events_run_org_fk" FOREIGN KEY ("runId","organizationId") REFERENCES "public"."curation_runs"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_runs" ADD CONSTRAINT "curation_runs_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_runs" ADD CONSTRAINT "curation_runs_requestedBy_users_id_fk" FOREIGN KEY ("requestedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_runs" ADD CONSTRAINT "curation_runs_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_runs" ADD CONSTRAINT "curation_runs_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curation_run_events_run_idx" ON "curation_run_events" USING btree ("organizationId","runId","createdAt");--> statement-breakpoint
CREATE INDEX "curation_runs_claim_idx" ON "curation_runs" USING btree ("priority" DESC NULLS LAST,"queuedAt") WHERE "curation_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "curation_runs_lease_idx" ON "curation_runs" USING btree ("leaseExpiresAt") WHERE "curation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "curation_runs_org_status_idx" ON "curation_runs" USING btree ("organizationId","status","queuedAt");--> statement-breakpoint
CREATE INDEX "curation_runs_variant_idx" ON "curation_runs" USING btree ("organizationId","variantId");--> statement-breakpoint
CREATE INDEX "curation_runs_case_idx" ON "curation_runs" USING btree ("organizationId","caseId");--> statement-breakpoint
CREATE UNIQUE INDEX "curation_runs_active_variant_uq" ON "curation_runs" USING btree ("organizationId","variantId") WHERE "curation_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "curation_runs_summary_gin" ON "curation_runs" USING gin ("summary");
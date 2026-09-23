-- SAM-VC workbench batches: a named group of ad-hoc curation runs, plus the
-- curator-saved institutional classification that lives on the entry itself.
--> statement-breakpoint
CREATE TABLE "curation_batches" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "name" varchar(160) NOT NULL,
  "createdBy" integer,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "curation_batches" ADD CONSTRAINT "curation_batches_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_batches" ADD CONSTRAINT "curation_batches_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_batches" ADD CONSTRAINT "curation_batches_id_org_uq" UNIQUE("id","organizationId");--> statement-breakpoint
ALTER TABLE "curation_runs" ADD COLUMN "batchId" integer;--> statement-breakpoint
ALTER TABLE "curation_runs" ADD COLUMN "institutionalLabel" varchar(80);--> statement-breakpoint
ALTER TABLE "curation_runs" ADD COLUMN "institutionalClass" varchar(16);--> statement-breakpoint
ALTER TABLE "curation_runs" ADD CONSTRAINT "curation_runs_batch_org_fk" FOREIGN KEY ("batchId","organizationId") REFERENCES "public"."curation_batches"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curation_runs_batch_idx" ON "curation_runs" USING btree ("organizationId","batchId");--> statement-breakpoint
CREATE UNIQUE INDEX "curation_batches_org_name_uq" ON "curation_batches" USING btree ("organizationId","name");

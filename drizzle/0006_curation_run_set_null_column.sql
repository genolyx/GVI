-- Restrict the engine-provenance FKs to nulling only `curationRunId` on delete.
--
-- `criteria_assessments` and `evidence_items` reference `curation_runs` on the
-- composite key (curationRunId, organizationId) so a tenant cannot attach itself to
-- another tenant's run. Plain ON DELETE SET NULL nulls *every* column in the
-- referencing key, so deleting a run also tried to null `organizationId`, which is
-- NOT NULL -- every delete failed with 23502.
--
-- Postgres 15+ allows naming the columns to null, which keeps the tenancy guarantee
-- while dropping only the provenance pointer. Drizzle cannot express the column
-- list, so these two constraints are maintained here; `onDelete("set null")` in
-- drizzle/schema.ts still describes the action, and drizzle-kit does not diff the
-- column list.
--> statement-breakpoint
ALTER TABLE "criteria_assessments" DROP CONSTRAINT "criteria_curation_run_org_fk";--> statement-breakpoint
ALTER TABLE "criteria_assessments"
  ADD CONSTRAINT "criteria_curation_run_org_fk"
  FOREIGN KEY ("curationRunId", "organizationId")
  REFERENCES "public"."curation_runs"("id", "organizationId")
  ON DELETE SET NULL ("curationRunId")
  ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_curation_run_org_fk";--> statement-breakpoint
ALTER TABLE "evidence_items"
  ADD CONSTRAINT "evidence_curation_run_org_fk"
  FOREIGN KEY ("curationRunId", "organizationId")
  REFERENCES "public"."curation_runs"("id", "organizationId")
  ON DELETE SET NULL ("curationRunId")
  ON UPDATE NO ACTION;

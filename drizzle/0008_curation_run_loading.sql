ALTER TYPE "public"."curation_run_status" ADD VALUE IF NOT EXISTS 'loading' AFTER 'queued';

DROP INDEX IF EXISTS "curation_runs_active_variant_uq";
CREATE UNIQUE INDEX "curation_runs_active_variant_uq" ON "curation_runs" USING btree ("organizationId","variantId") WHERE "curation_runs"."status" in ('queued', 'loading', 'running');

DROP INDEX IF EXISTS "curation_runs_lease_idx";
CREATE INDEX "curation_runs_lease_idx" ON "curation_runs" USING btree ("leaseExpiresAt") WHERE "curation_runs"."status" in ('loading', 'running');

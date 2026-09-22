CREATE TYPE "public"."variant_triage_tier" AS ENUM('t1_curate', 't2_review', 't3_filtered');--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "triageTier" "variant_triage_tier";--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "triageScore" integer;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "triageReasons" jsonb;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "triagedAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "variants_triage_idx" ON "variants" USING btree ("organizationId","caseId","triageTier","triageScore" DESC NULLS LAST);
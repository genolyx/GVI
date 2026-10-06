ALTER TABLE "germline_panels" ADD COLUMN IF NOT EXISTS "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "germline_panels" SET "shared" = true WHERE "shared" = false;--> statement-breakpoint
ALTER TABLE "germline_case_panels" DROP CONSTRAINT IF EXISTS "germline_case_panels_panel_org_fk";--> statement-breakpoint
ALTER TABLE "germline_case_panels" DROP CONSTRAINT IF EXISTS "germline_case_panels_panel_fk";--> statement-breakpoint
ALTER TABLE "germline_case_panels" ADD CONSTRAINT "germline_case_panels_panel_fk" FOREIGN KEY ("panelId") REFERENCES "public"."germline_panels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "germline_panels_code_lower_uq" ON "germline_panels" (lower("code"));

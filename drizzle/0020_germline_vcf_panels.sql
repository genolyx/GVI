CREATE TABLE "germline_panels" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "code" varchar(80) NOT NULL,
  "name" varchar(200) NOT NULL,
  "description" text,
  "genes" jsonb NOT NULL,
  "regions" jsonb,
  "genomeBuild" "reference_build",
  "contentHash" varchar(64) NOT NULL,
  "createdBy" integer NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "germline_panels" ADD CONSTRAINT "germline_panels_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_panels" ADD CONSTRAINT "germline_panels_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_panels" ADD CONSTRAINT "germline_panels_id_org_uq" UNIQUE("id","organizationId");--> statement-breakpoint
ALTER TABLE "germline_panels" ADD CONSTRAINT "germline_panels_org_code_uq" UNIQUE("organizationId","code");--> statement-breakpoint
CREATE TABLE "germline_case_panels" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "caseId" integer NOT NULL,
  "panelId" integer,
  "name" varchar(200) NOT NULL,
  "genes" jsonb NOT NULL,
  "regions" jsonb,
  "genomeBuild" "reference_build",
  "contentHash" varchar(64) NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "germline_case_panels" ADD CONSTRAINT "germline_case_panels_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_panels" ADD CONSTRAINT "germline_case_panels_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_panels" ADD CONSTRAINT "germline_case_panels_panel_org_fk" FOREIGN KEY ("panelId","organizationId") REFERENCES "public"."germline_panels"("id","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_panels" ADD CONSTRAINT "germline_case_panels_case_uq" UNIQUE("organizationId","caseId");

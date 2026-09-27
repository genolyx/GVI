CREATE TABLE "germline_case_reviews" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "caseId" integer NOT NULL,
  "reviewerName" varchar(160),
  "reviewerCode" varchar(80),
  "institution" varchar(200),
  "patientName" varchar(160),
  "patientDob" varchar(10),
  "patientGender" varchar(40),
  "partnerName" varchar(160),
  "languages" jsonb NOT NULL,
  "selectedVariantIds" jsonb,
  "pgxGenes" jsonb NOT NULL,
  "pgxExtended" jsonb NOT NULL,
  "updatedBy" integer,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "germline_case_reviews" ADD CONSTRAINT "germline_case_reviews_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_reviews" ADD CONSTRAINT "germline_case_reviews_case_org_fk" FOREIGN KEY ("caseId","organizationId") REFERENCES "public"."cases"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_reviews" ADD CONSTRAINT "germline_case_reviews_updatedBy_users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_case_reviews" ADD CONSTRAINT "germline_case_reviews_case_uq" UNIQUE("organizationId","caseId");--> statement-breakpoint
CREATE TABLE "germline_gene_knowledge" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "gene" varchar(80) NOT NULL,
  "language" varchar(8) NOT NULL,
  "disorder" text,
  "omimNumber" varchar(40),
  "inheritance" varchar(80),
  "functionSummary" text,
  "diseaseAssociation" text,
  "updatedBy" integer,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "germline_gene_knowledge" ADD CONSTRAINT "germline_gene_knowledge_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_gene_knowledge" ADD CONSTRAINT "germline_gene_knowledge_updatedBy_users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_gene_knowledge" ADD CONSTRAINT "germline_gene_knowledge_org_gene_lang_uq" UNIQUE("organizationId","gene","language");--> statement-breakpoint
CREATE TABLE "germline_variant_notes" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "variantId" integer NOT NULL,
  "notes" text NOT NULL,
  "updatedBy" integer,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "germline_variant_notes" ADD CONSTRAINT "germline_variant_notes_organizationId_organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_variant_notes" ADD CONSTRAINT "germline_variant_notes_variant_org_fk" FOREIGN KEY ("variantId","organizationId") REFERENCES "public"."variants"("id","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_variant_notes" ADD CONSTRAINT "germline_variant_notes_updatedBy_users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "germline_variant_notes" ADD CONSTRAINT "germline_variant_notes_variant_uq" UNIQUE("organizationId","variantId");

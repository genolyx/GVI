CREATE TABLE "somatic_knowledge_evidence_records" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "normalizedVariantId" varchar(240) NOT NULL,
  "sourceRecordId" varchar(200) NOT NULL,
  "sourceNativeLevel" varchar(80),
  "clinicalDomain" "evidence_clinical_domain" NOT NULL,
  "direction" "evidence_direction" DEFAULT 'neutral' NOT NULL,
  "summary" text NOT NULL,
  "sourceUrl" varchar(1000),
  "rawResponseHash" varchar(64) NOT NULL,
  "payload" jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_knowledge_evidence_records_id_org_uq" UNIQUE("id", "organizationId"),
  CONSTRAINT "somatic_knowledge_evidence_records_release_source_uq" UNIQUE("organizationId", "releaseId", "sourceRecordId"),
  CONSTRAINT "somatic_knowledge_evidence_records_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_knowledge_evidence_records_release_org_fk" FOREIGN KEY ("releaseId", "organizationId") REFERENCES "somatic_knowledge_releases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_knowledge_evidence_records_hash_ck" CHECK ("rawResponseHash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint

CREATE INDEX "somatic_knowledge_evidence_records_variant_idx"
ON "somatic_knowledge_evidence_records" ("organizationId", "releaseId", "normalizedVariantId");

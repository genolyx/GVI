CREATE TYPE "somatic_civic_import_status" AS ENUM ('queued', 'running', 'partial', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "somatic_civic_checkpoint_status" AS ENUM ('started', 'complete', 'partial', 'failed');--> statement-breakpoint

CREATE TABLE "somatic_civic_import_jobs" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "status" "somatic_civic_import_status" DEFAULT 'queued' NOT NULL,
  "scopeConfig" jsonb NOT NULL,
  "snapshotHash" varchar(64) NOT NULL,
  "queryHash" varchar(64) NOT NULL,
  "schemaHash" varchar(64) NOT NULL,
  "adapterHash" varchar(64) NOT NULL,
  "attemptCount" integer DEFAULT 0 NOT NULL,
  "maxAttempts" integer DEFAULT 3 NOT NULL,
  "availableAt" timestamp with time zone DEFAULT now() NOT NULL,
  "leaseOwner" varchar(160),
  "leaseExpiresAt" timestamp with time zone,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" jsonb,
  "cancelRequestedAt" timestamp with time zone,
  "cancelRequestedBy" integer,
  "requestedBy" integer NOT NULL,
  "startedAt" timestamp with time zone,
  "completedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_civic_import_jobs_id_org_release_uq" UNIQUE ("id", "organizationId", "releaseId"),
  CONSTRAINT "somatic_civic_import_jobs_hashes_ck" CHECK (
    "snapshotHash" ~ '^[0-9a-f]{64}$' AND "queryHash" ~ '^[0-9a-f]{64}$'
    AND "schemaHash" ~ '^[0-9a-f]{64}$' AND "adapterHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "somatic_civic_import_jobs_attempts_ck" CHECK (
    "attemptCount" >= 0 AND "maxAttempts" BETWEEN 1 AND 10 AND "attemptCount" <= "maxAttempts"
  ),
  CONSTRAINT "somatic_civic_import_jobs_scope_array_ck" CHECK (jsonb_typeof("scopeConfig") = 'array'),
  CONSTRAINT "somatic_civic_import_jobs_scope_no_phi_ck" CHECK (
    NOT jsonb_path_exists(
      "scopeConfig",
      '$[*].keyvalue() ? (@.key like_regex "(patient|case|sample|name|email|phone|address|dob|birth|mrn|clinical)" flag "i")'
    )
  ),
  CONSTRAINT "somatic_civic_import_jobs_lease_ck" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "somatic_civic_import_jobs_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_civic_import_jobs_release_org_fk" FOREIGN KEY ("releaseId", "organizationId")
    REFERENCES "somatic_knowledge_releases"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "somatic_civic_import_jobs_cancel_by_fk" FOREIGN KEY ("cancelRequestedBy") REFERENCES "users"("id"),
  CONSTRAINT "somatic_civic_import_jobs_requested_by_fk" FOREIGN KEY ("requestedBy") REFERENCES "users"("id")
);--> statement-breakpoint

CREATE INDEX "somatic_civic_import_jobs_org_release_idx"
  ON "somatic_civic_import_jobs" ("organizationId", "releaseId", "createdAt");--> statement-breakpoint
CREATE INDEX "somatic_civic_import_jobs_worker_idx"
  ON "somatic_civic_import_jobs" ("status", "availableAt", "leaseExpiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "somatic_civic_import_jobs_one_active_release_uq"
  ON "somatic_civic_import_jobs" ("organizationId", "releaseId")
  WHERE "status" IN ('queued', 'running');--> statement-breakpoint

CREATE TABLE "somatic_civic_import_checkpoints" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "jobId" integer NOT NULL,
  "scopeIndex" integer NOT NULL,
  "operationName" varchar(80) NOT NULL,
  "pageNumber" integer DEFAULT 0 NOT NULL,
  "cursor" varchar(1000),
  "status" "somatic_civic_checkpoint_status" NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_civic_import_checkpoints_operation_uq" UNIQUE (
    "organizationId", "jobId", "scopeIndex", "operationName", "pageNumber"
  ),
  CONSTRAINT "somatic_civic_import_checkpoints_position_ck" CHECK ("scopeIndex" >= 0 AND "pageNumber" >= 0),
  CONSTRAINT "somatic_civic_import_checkpoints_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_civic_import_checkpoints_job_org_release_fk"
    FOREIGN KEY ("jobId", "organizationId", "releaseId")
    REFERENCES "somatic_civic_import_jobs"("id", "organizationId", "releaseId") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "somatic_civic_import_checkpoints_job_idx"
  ON "somatic_civic_import_checkpoints" ("organizationId", "jobId", "scopeIndex");--> statement-breakpoint

CREATE TABLE "somatic_civic_raw_archives" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "organizationId" integer NOT NULL,
  "releaseId" integer NOT NULL,
  "jobId" integer NOT NULL,
  "scopeIndex" integer NOT NULL,
  "operationName" varchar(80) NOT NULL,
  "pageNumber" integer DEFAULT 0 NOT NULL,
  "requestId" varchar(80) NOT NULL,
  "rawBodyHash" varchar(64) NOT NULL,
  "storageKey" varchar(512) NOT NULL,
  "storageUrl" varchar(768) NOT NULL,
  "envelopeStorageKey" varchar(512) NOT NULL,
  "envelopeStorageUrl" varchar(768) NOT NULL,
  "byteSize" bigint NOT NULL,
  "envelope" jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "somatic_civic_raw_archives_request_uq" UNIQUE ("organizationId", "jobId", "requestId"),
  CONSTRAINT "somatic_civic_raw_archives_hash_ck" CHECK ("rawBodyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "somatic_civic_raw_archives_position_ck" CHECK ("scopeIndex" >= 0 AND "pageNumber" >= 0 AND "byteSize" >= 0),
  CONSTRAINT "somatic_civic_raw_archives_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id"),
  CONSTRAINT "somatic_civic_raw_archives_job_org_release_fk"
    FOREIGN KEY ("jobId", "organizationId", "releaseId")
    REFERENCES "somatic_civic_import_jobs"("id", "organizationId", "releaseId") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "somatic_civic_raw_archives_job_operation_idx"
  ON "somatic_civic_raw_archives" ("organizationId", "jobId", "scopeIndex", "operationName", "pageNumber");--> statement-breakpoint

CREATE TRIGGER "set_somatic_civic_import_jobs_updated_at"
BEFORE UPDATE ON "somatic_civic_import_jobs"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "set_somatic_civic_import_checkpoints_updated_at"
BEFORE UPDATE ON "somatic_civic_import_checkpoints"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

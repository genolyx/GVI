CREATE TABLE `ai_conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`variantId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`modelId` varchar(120) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ai_conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_conversations_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`conversationId` int NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`content` text NOT NULL,
	`citationIds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `analysis_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`jobId` int NOT NULL,
	`status` varchar(40) NOT NULL,
	`message` text NOT NULL,
	`progressPercent` int NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analysis_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `analysis_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`caseId` int NOT NULL,
	`pipeline` enum('vcf_ingest','gx_exome','gx_somatic') NOT NULL,
	`status` enum('queued','running','review_ready','failed','completed') NOT NULL DEFAULT 'queued',
	`progressPercent` int NOT NULL DEFAULT 0,
	`externalJobId` varchar(160),
	`idempotencyKey` varchar(80) NOT NULL,
	`manifest` json NOT NULL,
	`errorMessage` text,
	`createdBy` int NOT NULL,
	`claimedAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `analysis_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `analysis_jobs_idempotency_uq` UNIQUE(`idempotencyKey`),
	CONSTRAINT `analysis_jobs_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`actorUserId` int,
	`action` varchar(120) NOT NULL,
	`entityType` varchar(80) NOT NULL,
	`entityId` varchar(80) NOT NULL,
	`requestId` varchar(80) NOT NULL,
	`before` json,
	`after` json,
	`ipAddress` varchar(64),
	`userAgent` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `case_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`caseId` int NOT NULL,
	`sampleId` int,
	`kind` enum('vcf','fastq_r1','fastq_r2','bam','bai','report','other') NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`storageUrl` varchar(768) NOT NULL,
	`mimeType` varchar(160) NOT NULL,
	`byteSize` bigint NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`status` enum('uploaded','verified','rejected') NOT NULL DEFAULT 'uploaded',
	`uploadedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `case_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `case_files_org_storage_uq` UNIQUE(`organizationId`,`storageKey`)
);
--> statement-breakpoint
CREATE TABLE `cases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`projectId` int NOT NULL,
	`caseNumber` varchar(64) NOT NULL,
	`patientAlias` varchar(120) NOT NULL,
	`purpose` enum('germline','somatic') NOT NULL,
	`inputType` enum('vcf','fastq') NOT NULL,
	`status` enum('draft','queued','running','review_ready','in_review','reported','failed') NOT NULL DEFAULT 'draft',
	`referenceBuild` enum('GRCh37','GRCh38') NOT NULL,
	`panelName` varchar(160),
	`indication` text,
	`phenotypeText` text,
	`consentClinicalAnalysis` boolean NOT NULL,
	`consentSecondaryFindings` boolean NOT NULL DEFAULT false,
	`consentDataUse` boolean NOT NULL DEFAULT false,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cases_id` PRIMARY KEY(`id`),
	CONSTRAINT `cases_org_number_uq` UNIQUE(`organizationId`,`caseNumber`),
	CONSTRAINT `cases_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `criteria_assessments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`interpretationId` int NOT NULL,
	`code` varchar(20) NOT NULL,
	`state` enum('met','not_met','not_applicable') NOT NULL,
	`strengthOverride` varchar(40),
	`evidenceIds` json NOT NULL,
	`note` text,
	`updatedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `criteria_assessments_id` PRIMARY KEY(`id`),
	CONSTRAINT `criteria_interp_code_uq` UNIQUE(`organizationId`,`interpretationId`,`code`)
);
--> statement-breakpoint
CREATE TABLE `evidence_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`variantId` int NOT NULL,
	`source` enum('ClinVar','OMIM','gnomAD','PubMed','CIViC','OncoKB','Internal','Other') NOT NULL,
	`sourceRecordId` varchar(160),
	`title` text NOT NULL,
	`url` varchar(1000),
	`excerpt` text NOT NULL,
	`direction` enum('supporting','contradicting','neutral') NOT NULL DEFAULT 'neutral',
	`evidenceLevel` varchar(80),
	`payload` json,
	`accessedAt` timestamp NOT NULL DEFAULT (now()),
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `evidence_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `interpretations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`variantId` int NOT NULL,
	`mode` enum('germline','somatic') NOT NULL,
	`germlineClassification` enum('Pathogenic','Likely Pathogenic','VUS','Likely Benign','Benign'),
	`somaticTier` enum('Tier I','Tier II','Tier III','Tier IV'),
	`oncogenicity` enum('Oncogenic','Likely Oncogenic','VUS','Likely Benign','Benign'),
	`clinicalSignificance` varchar(160),
	`diseaseContext` varchar(255),
	`rationale` text NOT NULL,
	`status` enum('draft','in_review','approved') NOT NULL DEFAULT 'draft',
	`version` int NOT NULL DEFAULT 1,
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `interpretations_id` PRIMARY KEY(`id`),
	CONSTRAINT `interpretations_org_variant_version_uq` UNIQUE(`organizationId`,`variantId`,`version`),
	CONSTRAINT `interpretations_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `organization_invites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('administrator','analyst','clinician','viewer') NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`revokedAt` timestamp,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `organization_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_invites_token_uq` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('administrator','analyst','clinician','viewer') NOT NULL,
	`status` enum('invited','active','suspended') NOT NULL DEFAULT 'active',
	`invitedBy` int,
	`joinedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organization_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_members_org_user_uq` UNIQUE(`organizationId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`status` enum('active','suspended') NOT NULL DEFAULT 'active',
	`dataRegion` varchar(32) NOT NULL DEFAULT 'KR',
	`isolationMode` enum('shared_schema','dedicated_database') NOT NULL DEFAULT 'shared_schema',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `organizations_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`code` varchar(40) NOT NULL,
	`description` text,
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_org_code_uq` UNIQUE(`organizationId`,`code`),
	CONSTRAINT `projects_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`caseId` int NOT NULL,
	`version` int NOT NULL,
	`status` enum('draft','in_review','signed','amended') NOT NULL DEFAULT 'draft',
	`title` varchar(255) NOT NULL,
	`content` json NOT NULL,
	`snapshot` json,
	`snapshotHash` varchar(64),
	`parentReportId` int,
	`createdBy` int NOT NULL,
	`signedBy` int,
	`signedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `reports_org_case_version_uq` UNIQUE(`organizationId`,`caseId`,`version`),
	CONSTRAINT `reports_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `samples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`caseId` int NOT NULL,
	`sampleCode` varchar(80) NOT NULL,
	`role` enum('proband','mother','father','tumor','normal','other') NOT NULL,
	`specimenType` varchar(100) NOT NULL,
	`tumorContentPercent` decimal(5,2),
	`collectedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `samples_id` PRIMARY KEY(`id`),
	CONSTRAINT `samples_org_case_code_uq` UNIQUE(`organizationId`,`caseId`,`sampleCode`),
	CONSTRAINT `samples_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`organizationId` int NOT NULL,
	`caseId` int NOT NULL,
	`normalizedId` varchar(255) NOT NULL,
	`referenceBuild` enum('GRCh37','GRCh38') NOT NULL,
	`chromosome` varchar(16) NOT NULL,
	`position` int NOT NULL,
	`referenceAllele` text NOT NULL,
	`alternateAllele` text NOT NULL,
	`gene` varchar(80),
	`transcript` varchar(120),
	`hgvsC` varchar(255),
	`hgvsP` varchar(255),
	`consequence` varchar(160),
	`variantType` enum('SNV','INDEL','CNV','SV','FUSION','OTHER') NOT NULL,
	`zygosity` varchar(40),
	`populationAf` decimal(12,10),
	`vaf` decimal(12,10),
	`readDepth` int,
	`alternateDepth` int,
	`impact` enum('HIGH','MODERATE','LOW','MODIFIER','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
	`clinvarSignificance` varchar(160),
	`reviewStatus` enum('unreviewed','reviewing','reviewed','flagged') NOT NULL DEFAULT 'unreviewed',
	`annotation` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `variants_org_case_normalized_uq` UNIQUE(`organizationId`,`caseId`,`normalizedId`),
	CONSTRAINT `variants_id_org_uq` UNIQUE(`id`,`organizationId`)
);
--> statement-breakpoint
ALTER TABLE `ai_conversations` ADD CONSTRAINT `ai_conversations_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_conversations` ADD CONSTRAINT `ai_conversations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_conversations` ADD CONSTRAINT `ai_conversations_variant_org_fk` FOREIGN KEY (`variantId`,`organizationId`) REFERENCES `variants`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_messages` ADD CONSTRAINT `ai_messages_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_messages` ADD CONSTRAINT `ai_messages_conversation_org_fk` FOREIGN KEY (`conversationId`,`organizationId`) REFERENCES `ai_conversations`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_events` ADD CONSTRAINT `analysis_events_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_events` ADD CONSTRAINT `analysis_events_job_org_fk` FOREIGN KEY (`jobId`,`organizationId`) REFERENCES `analysis_jobs`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD CONSTRAINT `analysis_jobs_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD CONSTRAINT `analysis_jobs_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD CONSTRAINT `analysis_jobs_case_org_fk` FOREIGN KEY (`caseId`,`organizationId`) REFERENCES `cases`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_files` ADD CONSTRAINT `case_files_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_files` ADD CONSTRAINT `case_files_uploadedBy_users_id_fk` FOREIGN KEY (`uploadedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_files` ADD CONSTRAINT `case_files_case_org_fk` FOREIGN KEY (`caseId`,`organizationId`) REFERENCES `cases`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_files` ADD CONSTRAINT `case_files_sample_org_fk` FOREIGN KEY (`sampleId`,`organizationId`) REFERENCES `samples`(`id`,`organizationId`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cases` ADD CONSTRAINT `cases_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cases` ADD CONSTRAINT `cases_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cases` ADD CONSTRAINT `cases_project_org_fk` FOREIGN KEY (`projectId`,`organizationId`) REFERENCES `projects`(`id`,`organizationId`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `criteria_assessments` ADD CONSTRAINT `criteria_assessments_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `criteria_assessments` ADD CONSTRAINT `criteria_assessments_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `criteria_assessments` ADD CONSTRAINT `criteria_interpretation_org_fk` FOREIGN KEY (`interpretationId`,`organizationId`) REFERENCES `interpretations`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evidence_items` ADD CONSTRAINT `evidence_items_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evidence_items` ADD CONSTRAINT `evidence_items_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evidence_items` ADD CONSTRAINT `evidence_variant_org_fk` FOREIGN KEY (`variantId`,`organizationId`) REFERENCES `variants`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interpretations` ADD CONSTRAINT `interpretations_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interpretations` ADD CONSTRAINT `interpretations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interpretations` ADD CONSTRAINT `interpretations_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interpretations` ADD CONSTRAINT `interpretations_variant_org_fk` FOREIGN KEY (`variantId`,`organizationId`) REFERENCES `variants`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD CONSTRAINT `organization_invites_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD CONSTRAINT `organization_invites_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_invitedBy_users_id_fk` FOREIGN KEY (`invitedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_signedBy_users_id_fk` FOREIGN KEY (`signedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_case_org_fk` FOREIGN KEY (`caseId`,`organizationId`) REFERENCES `cases`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `samples` ADD CONSTRAINT `samples_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `samples` ADD CONSTRAINT `samples_case_org_fk` FOREIGN KEY (`caseId`,`organizationId`) REFERENCES `cases`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variants` ADD CONSTRAINT `variants_organizationId_organizations_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `variants` ADD CONSTRAINT `variants_case_org_fk` FOREIGN KEY (`caseId`,`organizationId`) REFERENCES `cases`(`id`,`organizationId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ai_messages_conversation_idx` ON `ai_messages` (`organizationId`,`conversationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `analysis_events_job_idx` ON `analysis_events` (`organizationId`,`jobId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `analysis_jobs_org_status_idx` ON `analysis_jobs` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `audit_events_org_time_idx` ON `audit_events` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`organizationId`,`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `case_files_case_idx` ON `case_files` (`organizationId`,`caseId`);--> statement-breakpoint
CREATE INDEX `cases_org_status_idx` ON `cases` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `cases_project_idx` ON `cases` (`organizationId`,`projectId`);--> statement-breakpoint
CREATE INDEX `evidence_variant_idx` ON `evidence_items` (`organizationId`,`variantId`);--> statement-breakpoint
CREATE INDEX `organization_invites_org_email_idx` ON `organization_invites` (`organizationId`,`email`);--> statement-breakpoint
CREATE INDEX `organization_members_user_idx` ON `organization_members` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `projects_org_status_idx` ON `projects` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `variants_workbench_idx` ON `variants` (`organizationId`,`caseId`,`gene`,`impact`);
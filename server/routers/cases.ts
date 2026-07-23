import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, like, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  analysisEvents,
  analysisJobs,
  caseFiles,
  cases,
  projects,
  samples,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";
import { parseVcf } from "../domain/vcf";
import { storageCreateUploadUrl, storageGetSignedUrl } from "../storage";

const caseStatus = z.enum([
  "draft",
  "queued",
  "running",
  "review_ready",
  "in_review",
  "reported",
  "failed",
]);

const sampleSchema = z.object({
  sampleCode: z.string().trim().min(1).max(80),
  role: z.enum(["proband", "mother", "father", "tumor", "normal", "other"]),
  specimenType: z.string().trim().min(1).max(100),
  tumorContentPercent: z.number().min(0).max(100).optional(),
});

function safeFileName(fileName: string) {
  return fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180);
}

async function requireCase(organizationId: number, caseId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
  return rows[0];
}

export const casesRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive().optional(),
        status: caseStatus.optional(),
        purpose: z.enum(["germline", "somatic"]).optional(),
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      const conditions = [eq(cases.organizationId, input.organizationId)];
      if (input.projectId) conditions.push(eq(cases.projectId, input.projectId));
      if (input.status) conditions.push(eq(cases.status, input.status));
      if (input.purpose) conditions.push(eq(cases.purpose, input.purpose));
      if (input.search) {
        conditions.push(
          or(
            like(cases.caseNumber, `%${input.search}%`),
            like(cases.patientAlias, `%${input.search}%`)
          )!
        );
      }
      return db
        .select({
          id: cases.id,
          projectId: cases.projectId,
          projectName: projects.name,
          caseNumber: cases.caseNumber,
          patientAlias: cases.patientAlias,
          purpose: cases.purpose,
          inputType: cases.inputType,
          referenceBuild: cases.referenceBuild,
          panelName: cases.panelName,
          status: cases.status,
          updatedAt: cases.updatedAt,
        })
        .from(cases)
        .innerJoin(
          projects,
          and(eq(projects.id, cases.projectId), eq(projects.organizationId, cases.organizationId))
        )
        .where(and(...conditions))
        .orderBy(desc(cases.updatedAt))
        .limit(input.limit);
    }),

  get: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), caseId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const clinicalCase = await requireCase(input.organizationId, input.caseId);
      const db = await requireDb();
      const [sampleRows, fileRows, jobRows, variantCount] = await Promise.all([
        db.select().from(samples).where(and(eq(samples.organizationId, input.organizationId), eq(samples.caseId, input.caseId))),
        db.select().from(caseFiles).where(and(eq(caseFiles.organizationId, input.organizationId), eq(caseFiles.caseId, input.caseId))),
        db.select().from(analysisJobs).where(and(eq(analysisJobs.organizationId, input.organizationId), eq(analysisJobs.caseId, input.caseId))).orderBy(desc(analysisJobs.createdAt)),
        db.select({ count: count() }).from(variants).where(and(eq(variants.organizationId, input.organizationId), eq(variants.caseId, input.caseId))),
      ]);
      return { ...clinicalCase, samples: sampleRows, files: fileRows, jobs: jobRows, variantCount: variantCount[0]?.count || 0 };
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive(),
        caseNumber: z.string().trim().min(2).max(64),
        patientAlias: z.string().trim().min(1).max(120),
        purpose: z.enum(["germline", "somatic"]),
        inputType: z.enum(["vcf", "fastq"]),
        referenceBuild: z.enum(["GRCh37", "GRCh38"]),
        panelName: z.string().trim().max(160).optional(),
        indication: z.string().trim().max(4000).optional(),
        phenotypeText: z.string().trim().max(4000).optional(),
        consentClinicalAnalysis: z.literal(true),
        consentSecondaryFindings: z.boolean().default(false),
        consentDataUse: z.boolean().default(false),
        samples: z.array(sampleSchema).min(1).max(5),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:create");
      const db = await requireDb();
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.organizationId, input.organizationId), eq(projects.status, "active")))
        .limit(1);
      if (!project[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      const caseId = await db.transaction(async tx => {
        const result = await tx.insert(cases).values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          caseNumber: input.caseNumber,
          patientAlias: input.patientAlias,
          purpose: input.purpose,
          inputType: input.inputType,
          referenceBuild: input.referenceBuild,
          panelName: input.panelName || null,
          indication: input.indication || null,
          phenotypeText: input.phenotypeText || null,
          consentClinicalAnalysis: input.consentClinicalAnalysis,
          consentSecondaryFindings: input.consentSecondaryFindings,
          consentDataUse: input.consentDataUse,
          createdBy: ctx.user.id,
        });
        const id = Number(result[0].insertId);
        await tx.insert(samples).values(
          input.samples.map(sample => ({
            organizationId: input.organizationId,
            caseId: id,
            sampleCode: sample.sampleCode,
            role: sample.role,
            specimenType: sample.specimenType,
            tumorContentPercent:
              sample.tumorContentPercent === undefined ? null : String(sample.tumorContentPercent),
          }))
        );
        return id;
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.created",
        entityType: "case",
        entityId: caseId,
        after: { caseNumber: input.caseNumber, purpose: input.purpose, inputType: input.inputType },
        req: ctx.req,
      });
      return { id: caseId };
    }),

  requestUpload: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        sampleId: z.number().int().positive().optional(),
        kind: z.enum(["vcf", "fastq_r1", "fastq_r2", "bam", "bai", "other"]),
        fileName: z.string().trim().min(1).max(255),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "file:upload");
      const clinicalCase = await requireCase(input.organizationId, input.caseId);
      if (clinicalCase.status !== "draft") {
        throw new TRPCError({ code: "CONFLICT", message: "Files can only be added to a draft case" });
      }
      if (input.sampleId) {
        const db = await requireDb();
        const sample = await db.select({ id: samples.id }).from(samples).where(
          and(eq(samples.id, input.sampleId), eq(samples.organizationId, input.organizationId), eq(samples.caseId, input.caseId))
        ).limit(1);
        if (!sample[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Sample not found" });
      }
      const key = `organizations/${input.organizationId}/cases/${input.caseId}/files/${randomUUID()}-${safeFileName(input.fileName)}`;
      return storageCreateUploadUrl(key);
    }),

  completeUpload: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        sampleId: z.number().int().positive().optional(),
        kind: z.enum(["vcf", "fastq_r1", "fastq_r2", "bam", "bai", "other"]),
        fileName: z.string().trim().min(1).max(255),
        storageKey: z.string().min(20).max(512),
        accessUrl: z.string().min(10).max(768),
        mimeType: z.string().min(1).max(160),
        byteSize: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "file:upload");
      await requireCase(input.organizationId, input.caseId);
      const requiredPrefix = `organizations/${input.organizationId}/cases/${input.caseId}/files/`;
      if (!input.storageKey.startsWith(requiredPrefix) || input.accessUrl !== `/manus-storage/${input.storageKey}`) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Storage path is outside the case boundary" });
      }
      const db = await requireDb();
      const result = await db.insert(caseFiles).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        sampleId: input.sampleId || null,
        kind: input.kind,
        fileName: input.fileName,
        storageKey: input.storageKey,
        storageUrl: input.accessUrl,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256.toLowerCase(),
        uploadedBy: ctx.user.id,
      });
      const id = Number(result[0].insertId);
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "file.uploaded",
        entityType: "case_file",
        entityId: id,
        after: { caseId: input.caseId, kind: input.kind, fileName: input.fileName, sha256: input.sha256 },
        req: ctx.req,
      });
      return { id };
    }),

  submit: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), caseId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:edit");
      const clinicalCase = await requireCase(input.organizationId, input.caseId);
      if (clinicalCase.status !== "draft") throw new TRPCError({ code: "CONFLICT", message: "Case is already submitted" });
      const db = await requireDb();
      const files = await db.select().from(caseFiles).where(
        and(eq(caseFiles.organizationId, input.organizationId), eq(caseFiles.caseId, input.caseId))
      );
      const kinds = new Set(files.map(file => file.kind));
      if (clinicalCase.inputType === "vcf" && !kinds.has("vcf")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A VCF file is required" });
      }
      if (clinicalCase.inputType === "fastq" && (!kinds.has("fastq_r1") || !kinds.has("fastq_r2"))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Paired FASTQ R1 and R2 files are required" });
      }
      const idempotencyKey = randomUUID();
      const manifest = {
        schemaVersion: "1.0",
        serviceCode: clinicalCase.inputType === "vcf"
          ? "gvi_vcf_ingest"
          : clinicalCase.purpose === "germline" ? "gx_exome" : "gx_somatic",
        organizationId: input.organizationId,
        caseId: input.caseId,
        purpose: clinicalCase.purpose,
        referenceBuild: clinicalCase.referenceBuild,
        panelName: clinicalCase.panelName,
        files: files.map(file => ({ id: file.id, kind: file.kind, storageKey: file.storageKey, sha256: file.sha256 })),
      };
      const result = await db.insert(analysisJobs).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        pipeline: clinicalCase.inputType === "vcf"
          ? "vcf_ingest"
          : clinicalCase.purpose === "germline" ? "gx_exome" : "gx_somatic",
        status: "queued",
        progressPercent: 0,
        idempotencyKey,
        manifest,
        createdBy: ctx.user.id,
      });
      const jobId = Number(result[0].insertId);
      await db.insert(analysisEvents).values({
        organizationId: input.organizationId,
        jobId,
        status: "queued",
        message: "분석 요청이 안전하게 접수되었습니다.",
        progressPercent: 0,
      });
      await db.update(cases).set({ status: "queued" }).where(
        and(eq(cases.id, input.caseId), eq(cases.organizationId, input.organizationId), eq(cases.status, "draft"))
      );

      const vcfFile = files.find(file => file.kind === "vcf");
      if (clinicalCase.inputType === "vcf" && vcfFile && vcfFile.byteSize <= 15 * 1024 * 1024) {
        try {
          const signedUrl = await storageGetSignedUrl(vcfFile.storageKey);
          const response = await fetch(signedUrl);
          if (!response.ok) throw new Error(`VCF download failed (${response.status})`);
          const raw = Buffer.from(await response.arrayBuffer());
          const digest = createHash("sha256").update(raw).digest("hex");
          if (digest !== vcfFile.sha256) throw new Error("VCF checksum mismatch");
          const text = vcfFile.fileName.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
          const parsed = parseVcf(text, clinicalCase.referenceBuild);
          if (!parsed.length) throw new Error("VCF contains no readable variant records");
          await db.transaction(async tx => {
            for (let offset = 0; offset < parsed.length; offset += 500) {
              await tx.insert(variants).values(parsed.slice(offset, offset + 500).map(variant => ({
                ...variant,
                organizationId: input.organizationId,
                caseId: input.caseId,
              })));
            }
            await tx.update(analysisJobs).set({ status: "review_ready", progressPercent: 100, completedAt: new Date() }).where(
              and(eq(analysisJobs.id, jobId), eq(analysisJobs.organizationId, input.organizationId))
            );
            await tx.insert(analysisEvents).values({
              organizationId: input.organizationId,
              jobId,
              status: "review_ready",
              message: `${parsed.length.toLocaleString()}개 변이를 정규화하여 검토 준비를 완료했습니다.`,
              progressPercent: 100,
            });
            await tx.update(cases).set({ status: "review_ready" }).where(
              and(eq(cases.id, input.caseId), eq(cases.organizationId, input.organizationId))
            );
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "VCF ingestion failed";
          await db.update(analysisJobs).set({ status: "failed", errorMessage: message, completedAt: new Date() }).where(
            and(eq(analysisJobs.id, jobId), eq(analysisJobs.organizationId, input.organizationId))
          );
          await db.insert(analysisEvents).values({
            organizationId: input.organizationId,
            jobId,
            status: "failed",
            message,
            progressPercent: 0,
          });
          await db.update(cases).set({ status: "failed" }).where(
            and(eq(cases.id, input.caseId), eq(cases.organizationId, input.organizationId))
          );
        }
      }

      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "case.submitted",
        entityType: "analysis_job",
        entityId: jobId,
        after: { caseId: input.caseId, pipeline: manifest.serviceCode, idempotencyKey },
        req: ctx.req,
      });
      return { jobId };
    }),

  timeline: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), caseId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      await requireCase(input.organizationId, input.caseId);
      const db = await requireDb();
      return db
        .select({
          id: analysisEvents.id,
          jobId: analysisEvents.jobId,
          status: analysisEvents.status,
          message: analysisEvents.message,
          progressPercent: analysisEvents.progressPercent,
          createdAt: analysisEvents.createdAt,
        })
        .from(analysisEvents)
        .innerJoin(
          analysisJobs,
          and(eq(analysisJobs.id, analysisEvents.jobId), eq(analysisJobs.organizationId, analysisEvents.organizationId))
        )
        .where(and(eq(analysisEvents.organizationId, input.organizationId), eq(analysisJobs.caseId, input.caseId)))
        .orderBy(desc(analysisEvents.createdAt));
    }),
});

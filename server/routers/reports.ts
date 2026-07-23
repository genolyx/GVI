import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cases,
  criteriaAssessments,
  evidenceItems,
  interpretations,
  reports,
  users,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { canTransitionReport, createReportDigest, isReportMutable } from "../domain/reportSnapshot";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const reportContentSchema = z.object({
  summary: z.string().max(12000),
  indication: z.string().max(8000),
  findings: z.string().max(20000),
  interpretation: z.string().max(30000),
  methodology: z.string().max(12000),
  limitations: z.string().max(12000),
  recommendations: z.string().max(12000),
});

async function requireReport(organizationId: number, reportId: number) {
  const db = await requireDb();
  const rows = await db.select().from(reports).where(and(eq(reports.id, reportId), eq(reports.organizationId, organizationId))).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Report not found" });
  return rows[0];
}

export const reportsRouter = router({
  list: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), caseId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:read");
      const db = await requireDb();
      const conditions = [eq(reports.organizationId, input.organizationId)];
      if (input.caseId) conditions.push(eq(reports.caseId, input.caseId));
      return db.select({
        id: reports.id,
        caseId: reports.caseId,
        caseNumber: cases.caseNumber,
        patientAlias: cases.patientAlias,
        purpose: cases.purpose,
        version: reports.version,
        status: reports.status,
        title: reports.title,
        snapshotHash: reports.snapshotHash,
        signedAt: reports.signedAt,
        updatedAt: reports.updatedAt,
      }).from(reports).innerJoin(cases, and(eq(cases.id, reports.caseId), eq(cases.organizationId, reports.organizationId))).where(and(...conditions)).orderBy(desc(reports.updatedAt));
    }),

  get: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:read");
      const db = await requireDb();
      const rows = await db.select({ report: reports, clinicalCase: cases, signerName: users.name, signerEmail: users.email })
        .from(reports)
        .innerJoin(cases, and(eq(cases.id, reports.caseId), eq(cases.organizationId, reports.organizationId)))
        .leftJoin(users, eq(users.id, reports.signedBy))
        .where(and(eq(reports.id, input.reportId), eq(reports.organizationId, input.organizationId))).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND" });
      return rows[0];
    }),

  createDraft: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), caseId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:draft");
      const db = await requireDb();
      const caseRows = await db.select().from(cases).where(and(eq(cases.id, input.caseId), eq(cases.organizationId, input.organizationId))).limit(1);
      const clinicalCase = caseRows[0];
      if (!clinicalCase) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
      const existing = await db.select().from(reports).where(and(eq(reports.organizationId, input.organizationId), eq(reports.caseId, input.caseId))).orderBy(desc(reports.version)).limit(1);
      if (existing[0] && !["signed", "amended"].includes(existing[0].status)) return { id: existing[0].id };
      const approved = await db.select({ interpretation: interpretations, variant: variants }).from(interpretations)
        .innerJoin(variants, and(eq(variants.id, interpretations.variantId), eq(variants.organizationId, interpretations.organizationId)))
        .where(and(eq(interpretations.organizationId, input.organizationId), eq(variants.caseId, input.caseId), eq(interpretations.status, "approved")));
      const findingLines = approved.map(({ variant, interpretation }) =>
        `${variant.gene || "Intergenic"} ${variant.hgvsC || variant.normalizedId}: ${interpretation.germlineClassification || interpretation.somaticTier || "Reviewed"}${interpretation.oncogenicity ? ` / ${interpretation.oncogenicity}` : ""}`
      );
      const content = {
        summary: approved.length ? `${approved.length}개의 승인된 변이가 본 보고서 초안에 포함되었습니다.` : "승인된 변이가 아직 없습니다. 전문가 검토 후 결과를 기술하십시오.",
        indication: clinicalCase.indication || "",
        findings: findingLines.join("\n"),
        interpretation: approved.map(({ interpretation }) => interpretation.rationale).join("\n\n"),
        methodology: `${clinicalCase.inputType.toUpperCase()} input; reference ${clinicalCase.referenceBuild}; ${clinicalCase.panelName || "panel not specified"}.`,
        limitations: "본 결과는 제출된 검체와 사용된 분석 범위에 한정됩니다. 독립적 임상 상관관계 검토가 필요합니다.",
        recommendations: "임상 맥락, 가족력 또는 종양 특성과 함께 검토하십시오.",
      };
      const result = await db.insert(reports).values({ organizationId: input.organizationId, caseId: input.caseId, version: (existing[0]?.version || 0) + 1, title: `${clinicalCase.caseNumber} ${clinicalCase.purpose === "germline" ? "Germline" : "Somatic"} Variant Interpretation Report`, content, parentReportId: existing[0]?.id || null, createdBy: ctx.user.id });
      const id = Number(result[0].insertId);
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.draft_created", entityType: "report", entityId: id, after: { caseId: input.caseId, version: (existing[0]?.version || 0) + 1 }, req: ctx.req });
      return { id };
    }),

  update: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive(), title: z.string().trim().min(3).max(255), content: reportContentSchema }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:draft");
      const report = await requireReport(input.organizationId, input.reportId);
      if (!isReportMutable(report.status)) throw new TRPCError({ code: "CONFLICT", message: "Only a draft report can be edited" });
      const db = await requireDb();
      await db.update(reports).set({ title: input.title, content: input.content }).where(and(eq(reports.id, input.reportId), eq(reports.organizationId, input.organizationId), eq(reports.status, "draft")));
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.updated", entityType: "report", entityId: input.reportId, before: { title: report.title, content: report.content }, after: { title: input.title, content: input.content }, req: ctx.req });
      return { success: true };
    }),

  submitReview: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:review");
      const report = await requireReport(input.organizationId, input.reportId);
      if (!canTransitionReport(report.status, "in_review")) throw new TRPCError({ code: "CONFLICT", message: "Invalid report state transition" });
      const db = await requireDb();
      await db.update(reports).set({ status: "in_review" }).where(and(eq(reports.id, input.reportId), eq(reports.organizationId, input.organizationId), eq(reports.status, "draft")));
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.review_requested", entityType: "report", entityId: input.reportId, before: { status: "draft" }, after: { status: "in_review" }, req: ctx.req });
      return { success: true };
    }),

  sign: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive(), confirmReportId: z.number().int().positive(), attestation: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const signerMembership = await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:sign");
      if (input.reportId !== input.confirmReportId) throw new TRPCError({ code: "BAD_REQUEST", message: "Report confirmation mismatch" });
      const report = await requireReport(input.organizationId, input.reportId);
      if (!canTransitionReport(report.status, "signed")) throw new TRPCError({ code: "CONFLICT", message: "Only an in-review report can be signed" });
      const db = await requireDb();
      const clinicalCase = await db.select().from(cases).where(and(eq(cases.id, report.caseId), eq(cases.organizationId, input.organizationId))).limit(1);
      const included = await db.select({ interpretation: interpretations, variant: variants }).from(interpretations).innerJoin(variants, and(eq(variants.id, interpretations.variantId), eq(variants.organizationId, interpretations.organizationId))).where(and(eq(interpretations.organizationId, input.organizationId), eq(variants.caseId, report.caseId), eq(interpretations.status, "approved")));
      const interpretationIds = included.map(item => item.interpretation.id);
      const criteria = interpretationIds.length ? await db.select().from(criteriaAssessments).where(and(eq(criteriaAssessments.organizationId, input.organizationId), inArray(criteriaAssessments.interpretationId, interpretationIds))) : [];
      const variantIds = included.map(item => item.variant.id);
      const evidence = variantIds.length ? await db.select().from(evidenceItems).where(and(eq(evidenceItems.organizationId, input.organizationId), inArray(evidenceItems.variantId, variantIds))) : [];
      const signedAt = new Date();
      const snapshot = {
        schemaVersion: "1.0",
        report: { id: report.id, version: report.version, title: report.title, content: report.content },
        case: clinicalCase[0],
        interpretations: included,
        criteria,
        evidence: evidence.map(item => ({ id: item.id, source: item.source, sourceRecordId: item.sourceRecordId, clinicalDomain: item.clinicalDomain, title: item.title, url: item.url, excerpt: item.excerpt, accessedAt: item.accessedAt })),
        signature: { userId: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: signerMembership.role, signedAt: signedAt.toISOString(), attestation: "I reviewed this report and electronically sign this immutable version." },
      } as Record<string, unknown>;
      const digest = createReportDigest(snapshot);
      const result = await db.update(reports).set({ status: "signed", snapshot, snapshotHash: digest.sha256, signedBy: ctx.user.id, signedAt }).where(and(eq(reports.id, report.id), eq(reports.organizationId, input.organizationId), eq(reports.status, "in_review")));
      if (Number(result[0].affectedRows) !== 1) throw new TRPCError({ code: "CONFLICT", message: "Report state changed before signing" });
      await db.update(cases).set({ status: "reported" }).where(and(eq(cases.id, report.caseId), eq(cases.organizationId, input.organizationId)));
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.signed", entityType: "report", entityId: report.id, before: { status: report.status }, after: { status: "signed", snapshotHash: digest.sha256, signedAt: signedAt.toISOString() }, req: ctx.req });
      return { snapshotHash: digest.sha256, signedAt };
    }),

  amend: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive(), reason: z.string().trim().min(10).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:draft");
      const report = await requireReport(input.organizationId, input.reportId);
      if (!canTransitionReport(report.status, "amended")) throw new TRPCError({ code: "CONFLICT", message: "Only a signed report can be amended" });
      const db = await requireDb();
      const newId = await db.transaction(async tx => {
        await tx.update(reports).set({ status: "amended" }).where(and(eq(reports.id, report.id), eq(reports.organizationId, input.organizationId), eq(reports.status, "signed")));
        const result = await tx.insert(reports).values({ organizationId: input.organizationId, caseId: report.caseId, version: report.version + 1, status: "draft", title: `${report.title} — Amendment`, content: { ...(report.content as Record<string, unknown>), amendmentReason: input.reason }, parentReportId: report.id, createdBy: ctx.user.id });
        return Number(result[0].insertId);
      });
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.amendment_created", entityType: "report", entityId: newId, before: { parentReportId: report.id, parentHash: report.snapshotHash }, after: { reason: input.reason, version: report.version + 1 }, req: ctx.req });
      return { id: newId };
    }),
});

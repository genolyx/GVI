import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cases,
  criteriaAssessments,
  curationRuns,
  evidenceItems,
  interpretations,
  reports,
  users,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import {
  curationSnapshotEntry,
  engineFromSummary,
  findingsFromApproved,
  type ReportVariantFinding,
} from "../domain/reportFindings";
import { canTransitionReport, createReportDigest, isReportMutable } from "../domain/reportSnapshot";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";
import type { CurationSummary } from "../../shared/curation/document";

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
      const findingRows = await attachEngineFindings(input.organizationId, approved);
      const content = {
        summary: approved.length ? `${approved.length} approved variant(s) included in this report draft.` : "No approved variants yet. Describe findings after expert review.",
        indication: clinicalCase.indication || "",
        findings: findingsFromApproved(findingRows),
        interpretation: approved.map(({ interpretation }) => interpretation.rationale).join("\n\n"),
        methodology: `${clinicalCase.inputType.toUpperCase()} input; reference ${clinicalCase.referenceBuild}; ${clinicalCase.panelName || "panel not specified"}.`,
        limitations: "Results are limited to the submitted specimen and analysis scope used. Independent clinical correlation is required.",
        recommendations: "Review in the context of clinical history, family history, or tumor characteristics.",
      };
      const result = await db.insert(reports).values({ organizationId: input.organizationId, caseId: input.caseId, version: (existing[0]?.version || 0) + 1, title: `${clinicalCase.caseNumber} ${clinicalCase.purpose === "germline" ? "Germline" : "Somatic"} Variant Interpretation Report`, content, parentReportId: existing[0]?.id || null, createdBy: ctx.user.id }).returning({ id: reports.id });
      const id = result[0].id;
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
      await db.update(cases).set({ status: "in_review" }).where(
        and(
          eq(cases.id, report.caseId),
          eq(cases.organizationId, input.organizationId),
          inArray(cases.status, ["review_ready", "in_review"])
        )
      );
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.review_requested", entityType: "report", entityId: input.reportId, before: { status: "draft" }, after: { status: "in_review" }, req: ctx.req });
      return { success: true };
    }),

  returnToDraft: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), reportId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "report:review");
      const report = await requireReport(input.organizationId, input.reportId);
      if (!canTransitionReport(report.status, "draft")) throw new TRPCError({ code: "CONFLICT", message: "Invalid report state transition" });
      const db = await requireDb();
      const result = await db.update(reports).set({ status: "draft" }).where(
        and(eq(reports.id, input.reportId), eq(reports.organizationId, input.organizationId), eq(reports.status, "in_review"))
      ).returning({ id: reports.id });
      if (result.length !== 1) throw new TRPCError({ code: "CONFLICT", message: "Report state changed before return to draft" });
      await db.update(cases).set({ status: "review_ready" }).where(
        and(eq(cases.id, report.caseId), eq(cases.organizationId, input.organizationId), eq(cases.status, "in_review"))
      );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "report.returned_to_draft",
        entityType: "report",
        entityId: input.reportId,
        before: { status: "in_review" },
        after: { status: "draft" },
        req: ctx.req,
      });
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
      const findingRows = await attachEngineFindings(input.organizationId, included);
      const signedAt = new Date();
      const snapshot = {
        schemaVersion: "1.1",
        report: { id: report.id, version: report.version, title: report.title, content: report.content },
        case: clinicalCase[0],
        interpretations: included,
        criteria,
        evidence: evidence.map(item => ({ id: item.id, source: item.source, sourceRecordId: item.sourceRecordId, clinicalDomain: item.clinicalDomain, title: item.title, url: item.url, excerpt: item.excerpt, accessedAt: item.accessedAt })),
        // Named hashes, not the documents themselves. Changing a curation document
        // after sign-off produces a different digest, which is the whole point of
        // putting the hash in the chain.
        curation: findingRows.map(curationSnapshotEntry).filter(Boolean),
        signature: { userId: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: signerMembership.role, signedAt: signedAt.toISOString(), attestation: "I reviewed this report and electronically sign this immutable version." },
      } as Record<string, unknown>;
      const digest = createReportDigest(snapshot);
      const result = await db.update(reports).set({ status: "signed", snapshot, snapshotHash: digest.sha256, signedBy: ctx.user.id, signedAt }).where(and(eq(reports.id, report.id), eq(reports.organizationId, input.organizationId), eq(reports.status, "in_review"))).returning({ id: reports.id });
      if (result.length !== 1) throw new TRPCError({ code: "CONFLICT", message: "Report state changed before signing" });
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
        const result = await tx.insert(reports).values({ organizationId: input.organizationId, caseId: report.caseId, version: report.version + 1, status: "draft", title: `${report.title} — Amendment`, content: { ...(report.content as Record<string, unknown>), amendmentReason: input.reason }, parentReportId: report.id, createdBy: ctx.user.id }).returning({ id: reports.id });
        return result[0].id;
      });
      await writeAuditEvent({ organizationId: input.organizationId, actorUserId: ctx.user.id, action: "report.amendment_created", entityType: "report", entityId: newId, before: { parentReportId: report.id, parentHash: report.snapshotHash }, after: { reason: input.reason, version: report.version + 1 }, req: ctx.req });
      return { id: newId };
    }),
});

/**
 * Latest succeeded curation run per approved variant, used both to seed draft
 * findings and to name the document hash on the signed snapshot.
 */
async function attachEngineFindings(
  organizationId: number,
  approved: { interpretation: typeof interpretations.$inferSelect; variant: typeof variants.$inferSelect }[]
): Promise<ReportVariantFinding[]> {
  const variantIds = approved.map(row => row.variant.id);
  const runs = variantIds.length
    ? await (await requireDb())
        .select({
          variantId: curationRuns.variantId,
          id: curationRuns.id,
          documentHash: curationRuns.documentHash,
          engineVersion: curationRuns.engineVersion,
          summary: curationRuns.summary,
          completedAt: curationRuns.completedAt,
        })
        .from(curationRuns)
        .where(
          and(
            eq(curationRuns.organizationId, organizationId),
            eq(curationRuns.status, "succeeded"),
            inArray(curationRuns.variantId, variantIds)
          )
        )
        .orderBy(desc(curationRuns.completedAt))
    : [];

  const latest = new Map<number, (typeof runs)[number]>();
  for (const run of runs) {
    if (run.variantId !== null && !latest.has(run.variantId)) latest.set(run.variantId, run);
  }

  return approved.map(({ variant, interpretation }) => {
    const run = latest.get(variant.id);
    return {
      gene: variant.gene,
      hgvsC: variant.hgvsC,
      normalizedId: variant.normalizedId,
      reviewerLabel: interpretation.germlineClassification || interpretation.somaticTier || "Reviewed",
      oncogenicity: interpretation.oncogenicity,
      rationale: interpretation.rationale,
      engine: run
        ? engineFromSummary(run.summary as CurationSummary | null, {
            documentHash: run.documentHash,
            runId: run.id,
            engineVersion: run.engineVersion,
          })
        : null,
    };
  });
}

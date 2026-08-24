import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiConversations,
  auditEvents,
  criteriaAssessments,
  evidenceItems,
  interpretations,
  variants,
  cases,
} from "../../drizzle/schema";
import {
  ACMG_CRITERIA,
  GERMLINE_CLASSIFICATIONS,
  ONCOGENICITY_CLASSIFICATIONS,
  SOMATIC_TIERS,
} from "../../shared/clinical-standards";
import { protectedProcedure, router } from "../_core/trpc";
import { suggestAcmgClassification } from "../domain/acmg";
import { writeAuditEvent } from "../domain/audit";
import { collectPublicEvidence } from "../domain/publicEvidence";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const acmgCode = z.enum(ACMG_CRITERIA);

async function requireVariant(organizationId: number, variantId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ variant: variants, clinicalCase: cases })
    .from(variants)
    .innerJoin(cases, and(eq(cases.id, variants.caseId), eq(cases.organizationId, variants.organizationId)))
    .where(and(eq(variants.id, variantId), eq(variants.organizationId, organizationId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
  return rows[0];
}

function evidenceDedupeKey(source: string, sourceRecordId: string | null | undefined, title: string) {
  if (sourceRecordId) return `${source}::${sourceRecordId}`;
  return `${source}::title::${title}`;
}

export const variantsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        gene: z.string().trim().max(80).optional(),
        variantType: z.enum(["SNV", "INDEL", "CNV", "SV", "FUSION", "OTHER"]).optional(),
        impact: z.enum(["HIGH", "MODERATE", "LOW", "MODIFIER", "UNKNOWN"]).optional(),
        reviewStatus: z.enum(["unreviewed", "reviewing", "reviewed", "flagged"]).optional(),
        maxPopulationAf: z.number().min(0).max(1).optional(),
        search: z.string().trim().max(100).optional(),
        sortBy: z.enum(["position", "gene", "impact", "populationAf", "vaf"]).default("position"),
        sortDirection: z.enum(["asc", "desc"]).default("asc"),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const db = await requireDb();
      const conditions = [
        eq(variants.organizationId, input.organizationId),
        eq(variants.caseId, input.caseId),
      ];
      if (input.gene) conditions.push(eq(variants.gene, input.gene));
      if (input.variantType) conditions.push(eq(variants.variantType, input.variantType));
      if (input.impact) conditions.push(eq(variants.impact, input.impact));
      if (input.reviewStatus) conditions.push(eq(variants.reviewStatus, input.reviewStatus));
      if (input.maxPopulationAf !== undefined) conditions.push(lte(variants.populationAf, String(input.maxPopulationAf)));
      if (input.search) {
        conditions.push(
          or(
            like(variants.gene, `%${input.search}%`),
            like(variants.hgvsC, `%${input.search}%`),
            like(variants.hgvsP, `%${input.search}%`),
            like(variants.normalizedId, `%${input.search}%`)
          )!
        );
      }
      const sortColumn = {
        position: variants.position,
        gene: variants.gene,
        impact: variants.impact,
        populationAf: variants.populationAf,
        vaf: variants.vaf,
      }[input.sortBy];
      return db
        .select({
          id: variants.id,
          normalizedId: variants.normalizedId,
          gene: variants.gene,
          hgvsC: variants.hgvsC,
          hgvsP: variants.hgvsP,
          consequence: variants.consequence,
          variantType: variants.variantType,
          zygosity: variants.zygosity,
          populationAf: variants.populationAf,
          vaf: variants.vaf,
          readDepth: variants.readDepth,
          impact: variants.impact,
          clinvarSignificance: variants.clinvarSignificance,
          reviewStatus: variants.reviewStatus,
          germlineClassification: interpretations.germlineClassification,
          somaticTier: interpretations.somaticTier,
          oncogenicity: interpretations.oncogenicity,
          interpretationStatus: interpretations.status,
        })
        .from(variants)
        .leftJoin(
          interpretations,
          and(
            eq(interpretations.variantId, variants.id),
            eq(interpretations.organizationId, variants.organizationId),
            // Join only the latest interpretation version per variant to avoid duplicate rows.
            sql`${interpretations.id} = (
              select i.id from interpretations i
              where i.variantId = ${variants.id}
                and i.organizationId = ${variants.organizationId}
              order by i.version desc, i.id desc
              limit 1
            )`
          )
        )
        .where(and(...conditions))
        .orderBy(input.sortDirection === "desc" ? desc(sortColumn) : asc(sortColumn))
        .limit(input.limit)
        .offset(input.offset);
    }),

  detail: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), variantId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const record = await requireVariant(input.organizationId, input.variantId);
      const db = await requireDb();
      const [evidence, interpretationRows, conversations, audit] = await Promise.all([
        db.select().from(evidenceItems).where(and(eq(evidenceItems.organizationId, input.organizationId), eq(evidenceItems.variantId, input.variantId))).orderBy(desc(evidenceItems.createdAt)),
        db.select().from(interpretations).where(and(eq(interpretations.organizationId, input.organizationId), eq(interpretations.variantId, input.variantId))).orderBy(desc(interpretations.version)),
        db.select().from(aiConversations).where(and(eq(aiConversations.organizationId, input.organizationId), eq(aiConversations.variantId, input.variantId))).orderBy(desc(aiConversations.updatedAt)),
        db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, input.organizationId), eq(auditEvents.entityType, "variant"), eq(auditEvents.entityId, String(input.variantId)))).orderBy(desc(auditEvents.createdAt)).limit(20),
      ]);
      const currentInterpretation = interpretationRows[0] || null;
      const criteria = currentInterpretation
        ? await db.select().from(criteriaAssessments).where(and(eq(criteriaAssessments.organizationId, input.organizationId), eq(criteriaAssessments.interpretationId, currentInterpretation.id)))
        : [];
      const metCodes = criteria.filter(item => item.state === "met" && ACMG_CRITERIA.includes(item.code as any)).map(item => item.code as (typeof ACMG_CRITERIA)[number]);
      return {
        ...record,
        evidence,
        interpretations: interpretationRows,
        criteria,
        acmgSuggestion: record.clinicalCase.purpose === "germline" ? suggestAcmgClassification(metCodes) : null,
        conversations,
        audit,
      };
    }),

  setReviewStatus: protectedProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      variantId: z.number().int().positive(),
      reviewStatus: z.enum(["unreviewed", "reviewing", "reviewed", "flagged"]),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const record = await requireVariant(input.organizationId, input.variantId);
      const db = await requireDb();
      await db.update(variants).set({ reviewStatus: input.reviewStatus }).where(and(eq(variants.id, input.variantId), eq(variants.organizationId, input.organizationId)));
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "variant.review_status_changed",
        entityType: "variant",
        entityId: input.variantId,
        before: { reviewStatus: record.variant.reviewStatus },
        after: { reviewStatus: input.reviewStatus },
        req: ctx.req,
      });
      return { success: true };
    }),

  refreshEvidence: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), variantId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const record = await requireVariant(input.organizationId, input.variantId);
      const drafts = await collectPublicEvidence(record.variant);
      const db = await requireDb();
      const existing = await db
        .select({
          source: evidenceItems.source,
          sourceRecordId: evidenceItems.sourceRecordId,
          title: evidenceItems.title,
        })
        .from(evidenceItems)
        .where(and(eq(evidenceItems.organizationId, input.organizationId), eq(evidenceItems.variantId, input.variantId)));
      const existingKeys = new Set(
        existing.map(item => evidenceDedupeKey(item.source, item.sourceRecordId, item.title))
      );
      const novel = drafts.filter(
        draft => !existingKeys.has(evidenceDedupeKey(draft.source, draft.sourceRecordId, draft.title))
      );
      if (novel.length) {
        await db.insert(evidenceItems).values(novel.map(draft => ({
          organizationId: input.organizationId,
          variantId: input.variantId,
          source: draft.source,
          sourceRecordId: draft.sourceRecordId,
          clinicalDomain: draft.clinicalDomain,
          title: draft.title,
          url: draft.url,
          excerpt: draft.excerpt,
          direction: draft.direction,
          evidenceLevel: draft.evidenceLevel,
          payload: draft.payload,
          createdBy: ctx.user.id,
        })));
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "evidence.refreshed",
        entityType: "variant",
        entityId: input.variantId,
        after: { evidenceCount: novel.length, sources: Array.from(new Set(novel.map(item => item.source))) },
        req: ctx.req,
      });
      return { count: novel.length };
    }),

  addEvidence: protectedProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      variantId: z.number().int().positive(),
      source: z.enum(["ClinVar", "OMIM", "gnomAD", "PubMed", "CIViC", "OncoKB", "Internal", "Other"]),
      clinicalDomain: z.enum(["germline_classification", "oncogenicity", "therapeutic", "diagnostic", "prognostic", "population", "functional", "other"]),
      sourceRecordId: z.string().trim().max(160).optional(),
      title: z.string().trim().min(2).max(1000),
      url: z.string().url().max(1000).optional(),
      excerpt: z.string().trim().min(2).max(8000),
      direction: z.enum(["supporting", "contradicting", "neutral"]),
      evidenceLevel: z.string().trim().max(80).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      await requireVariant(input.organizationId, input.variantId);
      const db = await requireDb();
      const result = await db.insert(evidenceItems).values({
        organizationId: input.organizationId,
        variantId: input.variantId,
        source: input.source,
        clinicalDomain: input.clinicalDomain,
        sourceRecordId: input.sourceRecordId || null,
        title: input.title,
        url: input.url || null,
        excerpt: input.excerpt,
        direction: input.direction,
        evidenceLevel: input.evidenceLevel || null,
        payload: input.payload || null,
        createdBy: ctx.user.id,
      });
      const id = Number(result[0].insertId);
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "evidence.added",
        entityType: "evidence_item",
        entityId: id,
        after: { variantId: input.variantId, source: input.source, clinicalDomain: input.clinicalDomain, direction: input.direction },
        req: ctx.req,
      });
      return { id };
    }),

  saveInterpretation: protectedProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      variantId: z.number().int().positive(),
      germlineClassification: z.enum(GERMLINE_CLASSIFICATIONS).optional(),
      somaticTier: z.enum(SOMATIC_TIERS).optional(),
      oncogenicity: z.enum(ONCOGENICITY_CLASSIFICATIONS).optional(),
      clinicalSignificance: z.string().trim().max(160).optional(),
      diseaseContext: z.string().trim().max(255).optional(),
      rationale: z.string().trim().min(20).max(12000),
      submitForReview: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const record = await requireVariant(input.organizationId, input.variantId);
      if (record.clinicalCase.purpose === "germline" && !input.germlineClassification) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Germline classification is required" });
      }
      if (record.clinicalCase.purpose === "somatic" && (!input.somaticTier || !input.oncogenicity)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Somatic tier and oncogenicity are required" });
      }
      const db = await requireDb();
      const existing = await db.select().from(interpretations).where(and(eq(interpretations.organizationId, input.organizationId), eq(interpretations.variantId, input.variantId))).orderBy(desc(interpretations.version)).limit(1);
      const values = {
        germlineClassification: record.clinicalCase.purpose === "germline" ? input.germlineClassification : null,
        somaticTier: record.clinicalCase.purpose === "somatic" ? input.somaticTier : null,
        oncogenicity: record.clinicalCase.purpose === "somatic" ? input.oncogenicity : null,
        clinicalSignificance: input.clinicalSignificance || null,
        diseaseContext: input.diseaseContext || null,
        rationale: input.rationale,
        status: input.submitForReview ? "in_review" as const : "draft" as const,
      };
      let id: number;
      if (existing[0] && existing[0].status !== "approved") {
        id = existing[0].id;
        await db.update(interpretations).set(values).where(and(eq(interpretations.id, id), eq(interpretations.organizationId, input.organizationId)));
      } else {
        const result = await db.insert(interpretations).values({
          organizationId: input.organizationId,
          variantId: input.variantId,
          mode: record.clinicalCase.purpose,
          ...values,
          version: (existing[0]?.version || 0) + 1,
          createdBy: ctx.user.id,
        });
        id = Number(result[0].insertId);
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "interpretation.saved",
        entityType: "interpretation",
        entityId: id,
        before: existing[0] ? { status: existing[0].status, version: existing[0].version } : null,
        after: { mode: record.clinicalCase.purpose, status: values.status, version: existing[0]?.status === "approved" ? existing[0].version + 1 : existing[0]?.version || 1 },
        req: ctx.req,
      });
      return { id };
    }),

  saveCriterion: protectedProcedure
    .input(z.object({
      organizationId: z.number().int().positive(),
      interpretationId: z.number().int().positive(),
      code: acmgCode,
      state: z.enum(["met", "not_met", "not_applicable"]),
      strengthOverride: z.string().trim().max(40).optional(),
      evidenceIds: z.array(z.number().int().positive()).max(50).default([]),
      note: z.string().trim().max(4000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const db = await requireDb();
      const interpretation = await db.select().from(interpretations).where(and(eq(interpretations.id, input.interpretationId), eq(interpretations.organizationId, input.organizationId), eq(interpretations.mode, "germline"))).limit(1);
      if (!interpretation[0] || interpretation[0].status === "approved") throw new TRPCError({ code: "CONFLICT", message: "Interpretation cannot be edited" });
      if (input.state === "met" && !input.note && input.evidenceIds.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Applied criterion requires evidence or a note" });
      }
      if (input.evidenceIds.length) {
        const evidence = await db.select({ id: evidenceItems.id }).from(evidenceItems).where(and(eq(evidenceItems.organizationId, input.organizationId), eq(evidenceItems.variantId, interpretation[0].variantId)));
        const validIds = new Set(evidence.map(item => item.id));
        if (input.evidenceIds.some(id => !validIds.has(id))) throw new TRPCError({ code: "BAD_REQUEST", message: "Evidence does not belong to this variant" });
      }
      await db.insert(criteriaAssessments).values({
        organizationId: input.organizationId,
        interpretationId: input.interpretationId,
        code: input.code,
        state: input.state,
        strengthOverride: input.strengthOverride || null,
        evidenceIds: input.evidenceIds,
        note: input.note || null,
        updatedBy: ctx.user.id,
      }).onDuplicateKeyUpdate({ set: {
        state: input.state,
        strengthOverride: input.strengthOverride || null,
        evidenceIds: input.evidenceIds,
        note: input.note || null,
        updatedBy: ctx.user.id,
      }});
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "criterion.assessed",
        entityType: "interpretation",
        entityId: input.interpretationId,
        after: { code: input.code, state: input.state, evidenceIds: input.evidenceIds },
        req: ctx.req,
      });
      return { success: true };
    }),

  approveInterpretation: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), interpretationId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:approve");
      const db = await requireDb();
      const rows = await db.select().from(interpretations).where(and(eq(interpretations.id, input.interpretationId), eq(interpretations.organizationId, input.organizationId))).limit(1);
      const interpretation = rows[0];
      if (!interpretation || interpretation.status !== "in_review") throw new TRPCError({ code: "CONFLICT", message: "Only an in-review interpretation can be approved" });
      await db.update(interpretations).set({ status: "approved", approvedBy: ctx.user.id, approvedAt: new Date() }).where(and(eq(interpretations.id, input.interpretationId), eq(interpretations.organizationId, input.organizationId), eq(interpretations.status, "in_review")));
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "interpretation.approved",
        entityType: "interpretation",
        entityId: input.interpretationId,
        before: { status: interpretation.status },
        after: { status: "approved" },
        req: ctx.req,
      });
      return { success: true };
    }),
});

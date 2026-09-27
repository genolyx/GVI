import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cases,
  germlineCaseReviews,
  germlineGeneKnowledge,
  germlineVariantNotes,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const language = z.enum(["EN", "CN", "KO"]);

const pgxGene = z.object({
  gene: z.string().trim().min(1).max(40),
  source: z.string().trim().max(80).default(""),
  diplotype: z.string().trim().max(120).default(""),
  phenotype: z.string().trim().max(240).default(""),
  alleleFunctions: z.string().trim().max(240).default(""),
  category: z.enum(["actionable", "normal", ""]).default(""),
  include: z.boolean(),
});

const pgxExtended = z.object({
  gene: z.string().trim().min(1).max(40),
  rsid: z.string().trim().max(40).default(""),
  variantName: z.string().trim().max(120).default(""),
  genotype: z.string().trim().max(40).default(""),
  zygosity: z.string().trim().max(40).default(""),
  significance: z.string().trim().max(240).default(""),
  drugs: z.string().trim().max(400).default(""),
  evidenceLevel: z.string().trim().max(40).default(""),
  include: z.boolean(),
});

async function requireGermlineCase(organizationId: number, caseId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ id: cases.id, purpose: cases.purpose })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Case not found." });
  }
  if (rows[0].purpose !== "germline") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Carrier review is only available for germline cases.",
    });
  }
}

export const germlineReviewRouter = router({
  get: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      await requireGermlineCase(input.organizationId, input.caseId);
      const db = await requireDb();
      const caseGenes = await db
        .selectDistinct({ gene: variants.gene })
        .from(variants)
        .where(
          and(
            eq(variants.organizationId, input.organizationId),
            eq(variants.caseId, input.caseId)
          )
        );
      const symbols = caseGenes
        .map(row => (row.gene || "").trim().toUpperCase())
        .filter(Boolean);
      const [reviewRows, noteRows, geneRows] = await Promise.all([
        db
          .select()
          .from(germlineCaseReviews)
          .where(
            and(
              eq(germlineCaseReviews.organizationId, input.organizationId),
              eq(germlineCaseReviews.caseId, input.caseId)
            )
          )
          .limit(1),
        db
          .select({
            variantId: germlineVariantNotes.variantId,
            notes: germlineVariantNotes.notes,
          })
          .from(germlineVariantNotes)
          .innerJoin(
            variants,
            and(
              eq(variants.id, germlineVariantNotes.variantId),
              eq(variants.organizationId, germlineVariantNotes.organizationId)
            )
          )
          .where(
            and(
              eq(germlineVariantNotes.organizationId, input.organizationId),
              eq(variants.caseId, input.caseId)
            )
          ),
        symbols.length
          ? db
              .select()
              .from(germlineGeneKnowledge)
              .where(
                and(
                  eq(germlineGeneKnowledge.organizationId, input.organizationId),
                  inArray(germlineGeneKnowledge.gene, symbols)
                )
              )
          : Promise.resolve([]),
      ]);
      const review = reviewRows[0];
      return {
        reviewerName: review?.reviewerName ?? "",
        reviewerCode: review?.reviewerCode ?? "",
        institution: review?.institution ?? "",
        patientName: review?.patientName ?? "",
        patientDob: review?.patientDob ?? "",
        patientGender: review?.patientGender ?? "",
        partnerName: review?.partnerName ?? "",
        languages: review?.languages ?? ["EN"],
        selectedVariantIds: review?.selectedVariantIds ?? null,
        pgxGenes: review?.pgxGenes ?? [],
        pgxExtended: review?.pgxExtended ?? [],
        notes: noteRows,
        genes: geneRows.map(row => ({
          gene: row.gene,
          language: row.language,
          disorder: row.disorder ?? "",
          omimNumber: row.omimNumber ?? "",
          inheritance: row.inheritance ?? "",
          functionSummary: row.functionSummary ?? "",
          diseaseAssociation: row.diseaseAssociation ?? "",
        })),
      };
    }),

  save: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        reviewerName: z.string().trim().max(160).default(""),
        reviewerCode: z.string().trim().max(80).default(""),
        institution: z.string().trim().max(200).default(""),
        patientName: z.string().trim().max(160).default(""),
        patientDob: z.string().trim().max(10).default(""),
        patientGender: z.string().trim().max(40).default(""),
        partnerName: z.string().trim().max(160).default(""),
        languages: z.array(language).min(1).max(3),
        selectedVariantIds: z.array(z.number().int().positive()).max(2000),
        pgxGenes: z.array(pgxGene).max(200),
        pgxExtended: z.array(pgxExtended).max(400),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireGermlineCase(input.organizationId, input.caseId);
      const db = await requireDb();
      if (input.selectedVariantIds.length) {
        const found = await db
          .select({ id: variants.id })
          .from(variants)
          .where(
            and(
              eq(variants.organizationId, input.organizationId),
              eq(variants.caseId, input.caseId),
              inArray(variants.id, input.selectedVariantIds)
            )
          );
        if (found.length !== new Set(input.selectedVariantIds).size) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A selected variant does not belong to this case.",
          });
        }
      }
      const values = {
        organizationId: input.organizationId,
        caseId: input.caseId,
        reviewerName: input.reviewerName || null,
        reviewerCode: input.reviewerCode || null,
        institution: input.institution || null,
        patientName: input.patientName || null,
        patientDob: input.patientDob || null,
        patientGender: input.patientGender || null,
        partnerName: input.partnerName || null,
        languages: input.languages,
        selectedVariantIds: input.selectedVariantIds,
        pgxGenes: input.pgxGenes,
        pgxExtended: input.pgxExtended,
        updatedBy: ctx.user.id,
        updatedAt: new Date(),
      };
      await db
        .insert(germlineCaseReviews)
        .values(values)
        .onConflictDoUpdate({
          target: [germlineCaseReviews.organizationId, germlineCaseReviews.caseId],
          set: values,
        });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "germline.review.saved",
        entityType: "case",
        entityId: input.caseId,
        after: {
          selected: input.selectedVariantIds.length,
          pgxGenes: input.pgxGenes.length,
          pgxExtended: input.pgxExtended.length,
          languages: input.languages,
        },
        req: ctx.req,
      });
      return { ok: true };
    }),

  saveGene: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        gene: z.string().trim().min(1).max(80),
        language,
        disorder: z.string().trim().max(400).default(""),
        omimNumber: z.string().trim().max(40).default(""),
        inheritance: z.string().trim().max(80).default(""),
        functionSummary: z.string().trim().max(8000).default(""),
        diseaseAssociation: z.string().trim().max(8000).default(""),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      const db = await requireDb();
      const gene = input.gene.toUpperCase();
      await db
        .insert(germlineGeneKnowledge)
        .values({
          organizationId: input.organizationId,
          gene,
          language: input.language,
          disorder: input.disorder || null,
          omimNumber: input.omimNumber || null,
          inheritance: input.inheritance || null,
          functionSummary: input.functionSummary || null,
          diseaseAssociation: input.diseaseAssociation || null,
          updatedBy: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: [
            germlineGeneKnowledge.organizationId,
            germlineGeneKnowledge.gene,
            germlineGeneKnowledge.language,
          ],
          set: {
            disorder: input.disorder || null,
            omimNumber: input.omimNumber || null,
            inheritance: input.inheritance || null,
            functionSummary: input.functionSummary || null,
            diseaseAssociation: input.diseaseAssociation || null,
            updatedBy: ctx.user.id,
            updatedAt: new Date(),
          },
        });
      return { gene };
    }),

  saveVariantNote: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        variantId: z.number().int().positive(),
        notes: z.string().trim().max(8000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      await requireGermlineCase(input.organizationId, input.caseId);
      const db = await requireDb();
      const owned = await db
        .select({ id: variants.id })
        .from(variants)
        .where(
          and(
            eq(variants.id, input.variantId),
            eq(variants.organizationId, input.organizationId),
            eq(variants.caseId, input.caseId)
          )
        )
        .limit(1);
      if (!owned[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Variant not found on this case.",
        });
      }
      await db
        .insert(germlineVariantNotes)
        .values({
          organizationId: input.organizationId,
          variantId: input.variantId,
          notes: input.notes,
          updatedBy: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: [
            germlineVariantNotes.organizationId,
            germlineVariantNotes.variantId,
          ],
          set: {
            notes: input.notes,
            updatedBy: ctx.user.id,
            updatedAt: new Date(),
          },
        });
      return { ok: true };
    }),
});

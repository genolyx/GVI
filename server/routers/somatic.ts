import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cases,
  somaticCaseContexts,
  somaticClinicalAssertions,
  somaticEvidenceRecords,
  somaticInterpretationRuns,
  somaticPanels,
  somaticPanelVersions,
  somaticTumorTypes,
  somaticVariantAnalyses,
  variants,
} from "../../drizzle/schema";
import {
  AMP_LEVELS,
  ONCOGENICITY_CLASSIFICATIONS,
  SOMATIC_TIERS,
} from "../../shared/clinical-standards";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { enqueueSomaticInterpretationRun } from "../domain/somatic/runEnqueue";
import { loadSomaticCase } from "../domain/somatic/runProcessor";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

export const somaticRouter = router({
  listReviewQueue: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const caseRows = await db
        .select({
          clinicalCase: cases,
          context: somaticCaseContexts,
          tumor: somaticTumorTypes,
          panel: somaticPanels,
          panelVersion: somaticPanelVersions,
        })
        .from(cases)
        .innerJoin(
          somaticCaseContexts,
          and(
            eq(somaticCaseContexts.caseId, cases.id),
            eq(somaticCaseContexts.organizationId, cases.organizationId)
          )
        )
        .innerJoin(
          somaticTumorTypes,
          eq(somaticTumorTypes.id, somaticCaseContexts.primaryTumorTypeId)
        )
        .innerJoin(
          somaticPanelVersions,
          and(
            eq(somaticPanelVersions.id, somaticCaseContexts.panelVersionId),
            eq(somaticPanelVersions.organizationId, cases.organizationId)
          )
        )
        .innerJoin(
          somaticPanels,
          and(
            eq(somaticPanels.id, somaticPanelVersions.panelId),
            eq(somaticPanels.organizationId, cases.organizationId)
          )
        )
        .where(
          and(
            eq(cases.organizationId, input.organizationId),
            eq(cases.purpose, "somatic")
          )
        )
        .orderBy(desc(cases.updatedAt));

      const caseIds = caseRows.map(row => row.clinicalCase.id);
      const runs = caseIds.length
        ? await db
            .select()
            .from(somaticInterpretationRuns)
            .where(
              and(
                eq(
                  somaticInterpretationRuns.organizationId,
                  input.organizationId
                ),
                inArray(somaticInterpretationRuns.caseId, caseIds)
              )
            )
            .orderBy(
              desc(somaticInterpretationRuns.createdAt),
              desc(somaticInterpretationRuns.id)
            )
        : [];
      const latestRunByCase = new Map<number, (typeof runs)[number]>();
      for (const run of runs) {
        if (!latestRunByCase.has(run.caseId)) {
          latestRunByCase.set(run.caseId, run);
        }
      }
      const latestRunIds = Array.from(latestRunByCase.values()).map(
        run => run.id
      );
      const assertions = latestRunIds.length
        ? await db
            .select({
              runId: somaticClinicalAssertions.runId,
              status: somaticClinicalAssertions.status,
            })
            .from(somaticClinicalAssertions)
            .where(
              and(
                eq(
                  somaticClinicalAssertions.organizationId,
                  input.organizationId
                ),
                inArray(somaticClinicalAssertions.runId, latestRunIds)
              )
            )
        : [];
      const assertionCounts = new Map<
        number,
        { total: number; approved: number; unresolved: number }
      >();
      for (const assertion of assertions) {
        const counts = assertionCounts.get(assertion.runId) ?? {
          total: 0,
          approved: 0,
          unresolved: 0,
        };
        counts.total += 1;
        if (assertion.status === "approved") counts.approved += 1;
        else counts.unresolved += 1;
        assertionCounts.set(assertion.runId, counts);
      }

      return caseRows.map(row => {
        const latestRun = latestRunByCase.get(row.clinicalCase.id) ?? null;
        return {
          ...row,
          latestRun,
          assertionCounts: latestRun
            ? (assertionCounts.get(latestRun.id) ?? {
                total: 0,
                approved: 0,
                unresolved: 0,
              })
            : { total: 0, approved: 0, unresolved: 0 },
        };
      });
    }),

  start: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "interpretation:edit"
      );
      return enqueueSomaticInterpretationRun({
        organizationId: input.organizationId,
        caseId: input.caseId,
        requestedBy: ctx.user.id,
        req: ctx.req,
      });
    }),

  caseReview: protectedProcedure
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
      const context = await loadSomaticCase(input.organizationId, input.caseId);
      const db = await requireDb();
      const runs = await db
        .select()
        .from(somaticInterpretationRuns)
        .where(
          and(
            eq(somaticInterpretationRuns.organizationId, input.organizationId),
            eq(somaticInterpretationRuns.caseId, input.caseId)
          )
        )
        .orderBy(desc(somaticInterpretationRuns.createdAt));
      const latestRun = runs[0] ?? null;
      const assertionRows = latestRun
        ? await db
            .select({
              assertion: somaticClinicalAssertions,
              variant: variants,
            })
            .from(somaticClinicalAssertions)
            .innerJoin(
              variants,
              and(
                eq(variants.id, somaticClinicalAssertions.variantId),
                eq(
                  variants.organizationId,
                  somaticClinicalAssertions.organizationId
                )
              )
            )
            .where(
              and(
                eq(
                  somaticClinicalAssertions.organizationId,
                  input.organizationId
                ),
                eq(somaticClinicalAssertions.runId, latestRun.id)
              )
            )
            .orderBy(asc(variants.gene), asc(variants.position))
        : [];
      const analysisRows = latestRun
        ? await db
            .select({
              analysis: somaticVariantAnalyses,
              variant: variants,
            })
            .from(somaticVariantAnalyses)
            .innerJoin(
              variants,
              and(
                eq(variants.id, somaticVariantAnalyses.variantId),
                eq(
                  variants.organizationId,
                  somaticVariantAnalyses.organizationId
                )
              )
            )
            .where(
              and(
                eq(somaticVariantAnalyses.organizationId, input.organizationId),
                eq(somaticVariantAnalyses.runId, latestRun.id)
              )
            )
            .orderBy(asc(variants.gene), asc(variants.position))
        : [];
      return {
        case: context.clinicalCase,
        context: context.context,
        tumor: context.tumor,
        panel: context.panel,
        panelVersion: context.panelVersion,
        runs,
        latestRun,
        assertions: assertionRows,
        analyses: analysisRows,
      };
    }),

  assertionDetail: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        assertionId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "variant:read"
      );
      const db = await requireDb();
      const rows = await db
        .select({
          assertion: somaticClinicalAssertions,
          variant: variants,
          tumor: somaticTumorTypes,
        })
        .from(somaticClinicalAssertions)
        .innerJoin(
          variants,
          and(
            eq(variants.id, somaticClinicalAssertions.variantId),
            eq(
              variants.organizationId,
              somaticClinicalAssertions.organizationId
            )
          )
        )
        .innerJoin(
          somaticTumorTypes,
          eq(somaticTumorTypes.id, somaticClinicalAssertions.tumorTypeId)
        )
        .where(
          and(
            eq(somaticClinicalAssertions.id, input.assertionId),
            eq(somaticClinicalAssertions.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!rows[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assertion not found.",
        });
      const evidenceIds = rows[0].assertion.evidenceIds;
      const evidence = evidenceIds.length
        ? await db
            .select()
            .from(somaticEvidenceRecords)
            .where(
              and(
                eq(somaticEvidenceRecords.organizationId, input.organizationId),
                inArray(somaticEvidenceRecords.id, evidenceIds)
              )
            )
        : [];
      return { ...rows[0], evidence };
    }),

  reviewAssertion: protectedProcedure
    .input(
      z
        .object({
          organizationId: z.number().int().positive(),
          assertionId: z.number().int().positive(),
          finalTier: z.enum(SOMATIC_TIERS),
          finalLevel: z.enum(AMP_LEVELS).nullable(),
          oncogenicity: z.enum(ONCOGENICITY_CLASSIFICATIONS),
          rationale: z.string().trim().min(20).max(8000),
          overrideReason: z.string().trim().max(4000).optional(),
          decision: z.enum(["save", "approve", "reject"]).default("save"),
        })
        .superRefine((value, ctx) => {
          if (
            value.decision !== "reject" &&
            (value.finalTier === "Tier I" || value.finalTier === "Tier II") &&
            !value.finalLevel
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["finalLevel"],
              message:
                "Tier I and Tier II require a separately recorded AMP evidence level.",
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        input.decision === "save"
          ? "interpretation:edit"
          : "interpretation:approve"
      );
      const db = await requireDb();
      const beforeRows = await db
        .select()
        .from(somaticClinicalAssertions)
        .where(
          and(
            eq(somaticClinicalAssertions.id, input.assertionId),
            eq(somaticClinicalAssertions.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!beforeRows[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Assertion not found.",
        });
      const before = beforeRows[0];
      const differsFromSystem =
        (before.systemTier && before.systemTier !== input.finalTier) ||
        (before.systemLevel && before.systemLevel !== input.finalLevel);
      if (
        input.decision !== "reject" &&
        differsFromSystem &&
        !input.overrideReason?.trim()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "An override reason is required when the final classification differs from the system proposal.",
        });
      }
      const rows = await db
        .update(somaticClinicalAssertions)
        .set({
          finalTier: input.finalTier,
          finalLevel: input.finalLevel,
          oncogenicity: input.oncogenicity,
          rationale: input.rationale,
          overrideReason: input.overrideReason || null,
          status:
            input.decision === "approve"
              ? "approved"
              : input.decision === "reject"
                ? "rejected"
                : "in_review",
          reviewedBy: ctx.user.id,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(somaticClinicalAssertions.id, input.assertionId),
            eq(somaticClinicalAssertions.organizationId, input.organizationId)
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action:
          input.decision === "approve"
            ? "somatic.assertion.approved"
            : input.decision === "reject"
              ? "somatic.assertion.rejected"
              : "somatic.assertion.reviewed",
        entityType: "somatic_clinical_assertion",
        entityId: input.assertionId,
        before: {
          finalTier: before.finalTier,
          finalLevel: before.finalLevel,
          oncogenicity: before.oncogenicity,
          status: before.status,
        },
        after: {
          finalTier: input.finalTier,
          finalLevel: input.finalLevel,
          oncogenicity: input.oncogenicity,
          status: rows[0].status,
          overrideReason: input.overrideReason || null,
        },
        req: ctx.req,
      });
      return rows[0];
    }),
});

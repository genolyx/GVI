import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { cases, interpretations, projects, variants } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

export const dashboardRouter = router({
  summary: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      const [statusRows, purposeRows, germlineRows, somaticRows, recentCases] = await Promise.all([
        db
          .select({ status: cases.status, count: count() })
          .from(cases)
          .where(eq(cases.organizationId, input.organizationId))
          .groupBy(cases.status),
        db
          .select({ purpose: cases.purpose, count: count() })
          .from(cases)
          .where(eq(cases.organizationId, input.organizationId))
          .groupBy(cases.purpose),
        db
          .select({ label: interpretations.germlineClassification, count: count() })
          .from(interpretations)
          .where(
            and(
              eq(interpretations.organizationId, input.organizationId),
              eq(interpretations.mode, "germline")
            )
          )
          .groupBy(interpretations.germlineClassification),
        db
          .select({ label: interpretations.somaticTier, count: count() })
          .from(interpretations)
          .where(
            and(
              eq(interpretations.organizationId, input.organizationId),
              eq(interpretations.mode, "somatic")
            )
          )
          .groupBy(interpretations.somaticTier),
        db
          .select({
            id: cases.id,
            caseNumber: cases.caseNumber,
            patientAlias: cases.patientAlias,
            purpose: cases.purpose,
            inputType: cases.inputType,
            status: cases.status,
            projectName: projects.name,
            updatedAt: cases.updatedAt,
          })
          .from(cases)
          .innerJoin(
            projects,
            and(eq(projects.id, cases.projectId), eq(projects.organizationId, cases.organizationId))
          )
          .where(eq(cases.organizationId, input.organizationId))
          .orderBy(desc(cases.updatedAt))
          .limit(8),
      ]);
      const statusCounts = Object.fromEntries(statusRows.map(row => [row.status, Number(row.count)]));
      const totalCases = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
      const reviewQueue = (statusCounts.review_ready || 0) + (statusCounts.in_review || 0);
      return {
        totalCases,
        reviewQueue,
        activeAnalyses: (statusCounts.queued || 0) + (statusCounts.running || 0),
        signedOrReported: statusCounts.reported || 0,
        statusDistribution: statusRows.map(row => ({ label: row.status, value: Number(row.count) })),
        purposeDistribution: purposeRows.map(row => ({ label: row.purpose, value: Number(row.count) })),
        classificationDistribution: [
          ...germlineRows.filter(row => row.label).map(row => ({ mode: "germline" as const, label: row.label!, value: Number(row.count) })),
          ...somaticRows.filter(row => row.label).map(row => ({ mode: "somatic" as const, label: row.label!, value: Number(row.count) })),
        ],
        recentCases,
      };
    }),
});

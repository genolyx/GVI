import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { analysisJobs, cases, curationBatches, curationRuns, interpretations, projects, variants } from "../../drizzle/schema";
import { isSingleVariantBatch } from "../../shared/curation/workbench";
import { protectedProcedure, router } from "../_core/trpc";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const ACTIVE_RUN = ["queued", "loading", "running"] as const;
const ACTIVE_JOB = ["queued", "running"] as const;

const STATUS_RANK: Record<string, number> = { loading: 0, running: 1, queued: 2 };

const PIPELINE_LABEL: Record<string, string> = {
  vcf_ingest: "VCF ingest",
  gx_exome: "Exome pipeline",
  gx_somatic: "Somatic pipeline",
};

type ActiveWorkItem = {
  key: string;
  kind: "case" | "batch" | "single";
  title: string;
  detail: string;
  status: "queued" | "loading" | "running";
  caseId: number | null;
  batchId: number | null;
};

export const dashboardRouter = router({
  summary: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      const [statusRows, purposeRows, germlineRows, somaticRows, recentCases, activeRuns, activeJobs] = await Promise.all([
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
        db
          .select({
            id: curationRuns.id,
            status: curationRuns.status,
            caseId: curationRuns.caseId,
            batchId: curationRuns.batchId,
            input: curationRuns.input,
            batchName: curationBatches.name,
            caseNumber: cases.caseNumber,
          })
          .from(curationRuns)
          .leftJoin(
            curationBatches,
            and(eq(curationBatches.id, curationRuns.batchId), eq(curationBatches.organizationId, curationRuns.organizationId))
          )
          .leftJoin(
            cases,
            and(eq(cases.id, curationRuns.caseId), eq(cases.organizationId, curationRuns.organizationId))
          )
          .where(and(eq(curationRuns.organizationId, input.organizationId), inArray(curationRuns.status, [...ACTIVE_RUN]))),
        db
          .select({
            id: analysisJobs.id,
            caseId: analysisJobs.caseId,
            pipeline: analysisJobs.pipeline,
            status: analysisJobs.status,
            caseNumber: cases.caseNumber,
          })
          .from(analysisJobs)
          .innerJoin(cases, and(eq(cases.id, analysisJobs.caseId), eq(cases.organizationId, analysisJobs.organizationId)))
          .where(and(eq(analysisJobs.organizationId, input.organizationId), inArray(analysisJobs.status, [...ACTIVE_JOB]))),
      ]);
      const statusCounts = Object.fromEntries(statusRows.map(row => [row.status, Number(row.count)]));
      const totalCases = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
      const reviewQueue = (statusCounts.review_ready || 0) + (statusCounts.in_review || 0);
      const activeWork = buildActiveWork(activeRuns, activeJobs);
      return {
        totalCases,
        reviewQueue,
        activeAnalyses: activeRuns.length + activeJobs.length,
        signedOrReported: statusCounts.reported || 0,
        statusDistribution: statusRows.map(row => ({ label: row.status, value: Number(row.count) })),
        purposeDistribution: purposeRows.map(row => ({ label: row.purpose, value: Number(row.count) })),
        classificationDistribution: [
          ...germlineRows.filter(row => row.label).map(row => ({ mode: "germline" as const, label: row.label!, value: Number(row.count) })),
          ...somaticRows.filter(row => row.label).map(row => ({ mode: "somatic" as const, label: row.label!, value: Number(row.count) })),
        ],
        recentCases,
        activeWork,
      };
    }),
});

function variantLabel(input: { gene?: string | null; hgvsC?: string | null }) {
  return [input.gene, input.hgvsC].filter(Boolean).join(" ");
}

function activeStatus(status: string): ActiveWorkItem["status"] {
  if (status === "loading" || status === "running") return status;
  return "queued";
}

function buildActiveWork(
  runs: {
    id: number;
    status: string;
    caseId: number | null;
    batchId: number | null;
    input: { gene?: string | null; hgvsC?: string | null };
    batchName: string | null;
    caseNumber: string | null;
  }[],
  jobs: {
    id: number;
    caseId: number;
    pipeline: string;
    status: string;
    caseNumber: string;
  }[]
): ActiveWorkItem[] {
  const groups = new Map<string, { kind: ActiveWorkItem["kind"]; title: string; caseId: number | null; batchId: number | null; runs: typeof runs }>();
  for (const run of runs) {
    const namedBatch = run.batchId != null && run.batchName != null && !isSingleVariantBatch(run.batchName);
    const key = namedBatch
      ? `batch:${run.batchId}`
      : run.caseId != null && run.caseNumber
        ? `case:${run.caseId}`
        : `single:${run.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    groups.set(key, {
      kind: namedBatch ? "batch" : run.caseId != null && run.caseNumber ? "case" : "single",
      title: namedBatch ? run.batchName! : run.caseNumber || run.input.gene || "Single variant",
      caseId: namedBatch ? null : run.caseId,
      batchId: namedBatch || (!run.caseId && run.batchId) ? run.batchId : null,
      runs: [run],
    });
  }

  const items: ActiveWorkItem[] = Array.from(groups.entries()).map(([key, group]) => {
    const ordered = group.runs.slice().sort((left, right) => (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9));
    const head = ordered[0]!;
    const label = variantLabel(head.input);
    const detail =
      group.kind === "single"
        ? head.input.hgvsC || "Single variant"
        : group.runs.length === 1
          ? label || "1 variant"
          : label
            ? `${label} · ${group.runs.length - 1} more`
            : `${group.runs.length} variants`;
    return {
      key,
      kind: group.kind,
      title: group.title,
      detail,
      status: activeStatus(head.status),
      caseId: group.caseId,
      batchId: group.batchId,
    };
  });

  for (const job of jobs) {
    items.push({
      key: `job:${job.id}`,
      kind: "case",
      title: job.caseNumber,
      detail: PIPELINE_LABEL[job.pipeline] || "Case analysis",
      status: activeStatus(job.status),
      caseId: job.caseId,
      batchId: null,
    });
  }

  return items.sort(
    (left, right) => (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9) || left.title.localeCompare(right.title)
  );
}

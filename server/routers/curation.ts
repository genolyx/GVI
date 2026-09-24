import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { cases, curationRunEvents, curationRuns, variants } from "../../drizzle/schema";
import { curationDocumentSchema } from "../../shared/curation/document";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import {
  assertCurationSupported,
  buildCurationInputForVariant,
  enqueueCurationRun,
} from "../domain/curationQueue";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";
import { TRIAGE_TIERS } from "../domain/triage";
import { runTriagePass } from "../domain/triagePass";
import { storageGetText } from "../storage";

const orgInput = z.object({ organizationId: z.number().int().positive() });

/** Priority band for a single variant a reviewer is actively looking at. */
const INTERACTIVE_PRIORITY = 100;
/** Bulk triage batches yield to interactive requests. */
const BULK_PRIORITY = 10;

async function requireRun(organizationId: number, runId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(curationRuns)
    .where(and(eq(curationRuns.organizationId, organizationId), eq(curationRuns.id, runId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Curation run not found" });
  return rows[0];
}

/**
 * Queue many stored variants, reporting per-variant failures instead of aborting.
 *
 * A reviewer selecting 200 variants should not lose the other 199 because one row
 * lacks HGVS notation or is already in the queue.
 */
async function enqueueVariants(
  organizationId: number,
  variantIds: readonly number[],
  options: { requestedBy: number; runLiterature: boolean; priority: number }
) {
  const queued: number[] = [];
  const skipped: { variantId: number; reason: string }[] = [];

  for (const variantId of variantIds) {
    try {
      const { input: engineInput, caseId } = await buildCurationInputForVariant(
        organizationId,
        variantId,
        { runLiterature: options.runLiterature }
      );
      const { id, deduped } = await enqueueCurationRun({
        organizationId,
        caseId,
        variantId,
        input: engineInput,
        priority: options.priority,
        requestedBy: options.requestedBy,
      });
      if (deduped) skipped.push({ variantId, reason: "Already queued or running" });
      else queued.push(id);
    } catch (error) {
      skipped.push({
        variantId,
        reason: error instanceof TRPCError ? error.message : "Could not queue",
      });
    }
  }

  return { queued, skipped };
}

export const curationRouter = router({
  /** Queue the engine for one stored variant. */
  enqueueVariant: protectedProcedure
    .input(
      orgInput.extend({
        variantId: z.number().int().positive(),
        runLiterature: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const { input: engineInput, caseId } = await buildCurationInputForVariant(
        input.organizationId,
        input.variantId,
        { runLiterature: input.runLiterature }
      );

      const { id, deduped } = await enqueueCurationRun({
        organizationId: input.organizationId,
        caseId,
        variantId: input.variantId,
        input: engineInput,
        priority: INTERACTIVE_PRIORITY,
        requestedBy: ctx.user.id,
      });

      if (!deduped) {
        await writeAuditEvent({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          action: "curation.run_queued",
          entityType: "curation_run",
          entityId: id,
          after: { variantId: input.variantId, gene: engineInput.gene, hgvsC: engineInput.hgvsC },
          req: ctx.req,
        });
      }
      return { id, deduped };
    }),

  /** Queue an explicit selection of variants from the Workbench. */
  enqueueBulk: protectedProcedure
    .input(
      orgInput.extend({
        variantIds: z.array(z.number().int().positive()).min(1).max(500),
        runLiterature: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");

      const { queued, skipped } = await enqueueVariants(input.organizationId, input.variantIds, {
        requestedBy: ctx.user.id,
        runLiterature: input.runLiterature,
        priority: BULK_PRIORITY,
      });

      if (queued.length) {
        await writeAuditEvent({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          action: "curation.bulk_queued",
          entityType: "case",
          entityId: input.organizationId,
          after: { queued: queued.length, skipped: skipped.length },
          req: ctx.req,
        });
      }
      return { queued, skipped };
    }),

  /**
   * Score every variant in a case and assign a triage tier.
   *
   * Cheap and idempotent — it reads only columns already on the row and makes no
   * external calls — so it is safe to re-run whenever annotation improves.
   */
  runTriage: protectedProcedure
    .input(
      orgInput.extend({
        caseId: z.number().int().positive(),
        /** Skip variants already triaged, for incremental ingests. */
        onlyUntriaged: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const result = await runTriagePass(input.organizationId, input.caseId, {
        onlyUntriaged: input.onlyUntriaged,
      });

      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.triage_pass",
        entityType: "case",
        entityId: input.caseId,
        after: result,
        req: ctx.req,
      });
      return result;
    }),

  /**
   * Queue a whole triage tier for a case, defaulting to T1.
   *
   * This is the action that makes the integration affordable: it turns one click
   * into exactly the engine work the triage rules judged worthwhile.
   */
  enqueueTier: protectedProcedure
    .input(
      orgInput.extend({
        caseId: z.number().int().positive(),
        tier: z.enum(TRIAGE_TIERS).default("t1_curate"),
        limit: z.number().int().min(1).max(500).default(200),
        runLiterature: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const db = await requireDb();

      const candidates = await db
        .select({ id: variants.id })
        .from(variants)
        .where(
          and(
            eq(variants.organizationId, input.organizationId),
            eq(variants.caseId, input.caseId),
            eq(variants.triageTier, input.tier)
          )
        )
        // Highest-scoring first, so a truncated batch is still the best batch.
        .orderBy(desc(variants.triageScore), variants.id)
        .limit(input.limit);

      if (!candidates.length) {
        return { queued: [] as number[], skipped: [] as { variantId: number; reason: string }[] };
      }

      const result = await enqueueVariants(
        input.organizationId,
        candidates.map(row => row.id),
        { requestedBy: ctx.user.id, runLiterature: input.runLiterature, priority: BULK_PRIORITY }
      );

      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.tier_queued",
        entityType: "case",
        entityId: input.caseId,
        after: { tier: input.tier, queued: result.queued.length, skipped: result.skipped.length },
        req: ctx.req,
      });
      return result;
    }),

  /**
   * Curate a variant that was never ingested, by gene + HGVS.
   *
   * This is SAM-VC's day-to-day workflow and the reason `curation_runs.variantId`
   * and `caseId` are nullable.
   */
  enqueueAdHoc: protectedProcedure
    .input(
      orgInput.extend({
        gene: z.string().trim().min(1).max(80),
        hgvsC: z.string().trim().min(3).max(255),
        transcript: z.string().trim().max(120).optional(),
        hgvsP: z.string().trim().max(255).optional(),
        clinicalNotes: z.string().trim().max(4000).optional(),
        caseId: z.number().int().positive().optional(),
        runLiterature: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");

      if (input.caseId) {
        const db = await requireDb();
        const rows = await db
          .select({ referenceBuild: cases.referenceBuild })
          .from(cases)
          .where(and(eq(cases.organizationId, input.organizationId), eq(cases.id, input.caseId)))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
        assertCurationSupported(rows[0].referenceBuild);
      }

      const { id } = await enqueueCurationRun({
        organizationId: input.organizationId,
        caseId: input.caseId ?? null,
        variantId: null,
        input: {
          gene: input.gene,
          hgvsC: input.hgvsC,
          transcript: input.transcript || null,
          hgvsP: input.hgvsP || null,
          clinicalNotes: input.clinicalNotes || null,
          referenceBuild: "GRCh38",
          runLiterature: input.runLiterature,
        },
        priority: INTERACTIVE_PRIORITY,
        requestedBy: ctx.user.id,
      });

      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.adhoc_queued",
        entityType: "curation_run",
        entityId: id,
        after: { gene: input.gene, hgvsC: input.hgvsC, caseId: input.caseId ?? null },
        req: ctx.req,
      });
      return { id };
    }),

  /** Run rows without their documents, for list views and polling. */
  list: protectedProcedure
    .input(
      orgInput.extend({
        caseId: z.number().int().positive().optional(),
        variantId: z.number().int().positive().optional(),
        status: z
          .array(z.enum(["queued", "loading", "running", "succeeded", "failed", "cancelled"]))
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const db = await requireDb();

      const conditions = [eq(curationRuns.organizationId, input.organizationId)];
      if (input.caseId) conditions.push(eq(curationRuns.caseId, input.caseId));
      if (input.variantId) conditions.push(eq(curationRuns.variantId, input.variantId));
      if (input.status?.length) conditions.push(inArray(curationRuns.status, input.status));

      return db
        .select({
          id: curationRuns.id,
          caseId: curationRuns.caseId,
          variantId: curationRuns.variantId,
          status: curationRuns.status,
          attempt: curationRuns.attempt,
          maxAttempts: curationRuns.maxAttempts,
          input: curationRuns.input,
          summary: curationRuns.summary,
          error: curationRuns.error,
          engineVersion: curationRuns.engineVersion,
          contractVersion: curationRuns.contractVersion,
          documentHash: curationRuns.documentHash,
          queuedAt: curationRuns.queuedAt,
          startedAt: curationRuns.startedAt,
          completedAt: curationRuns.completedAt,
          gene: variants.gene,
          hgvsC: variants.hgvsC,
        })
        .from(curationRuns)
        .leftJoin(
          variants,
          and(
            eq(variants.id, curationRuns.variantId),
            eq(variants.organizationId, curationRuns.organizationId)
          )
        )
        .where(and(...conditions))
        .orderBy(desc(curationRuns.queuedAt))
        .limit(input.limit);
    }),

  /**
   * The full CurationDocument for a finished run.
   *
   * Served through tRPC rather than a presigned URL so the tenant check happens
   * server-side and the payload is re-validated against the contract before the
   * client renders any of it.
   */
  document: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const run = await requireRun(input.organizationId, input.runId);
      if (run.status !== "succeeded" || !run.documentKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Curation run is ${run.status}; no document to read yet.`,
        });
      }

      const body = await storageGetText(run.documentKey);
      const parsed = curationDocumentSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stored curation document does not match contract v1",
        });
      }
      return {
        runId: run.id,
        variantId: run.variantId,
        caseId: run.caseId,
        documentHash: run.documentHash,
        completedAt: run.completedAt,
        document: parsed.data,
      };
    }),

  events: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      await requireRun(input.organizationId, input.runId);
      const db = await requireDb();
      return db
        .select()
        .from(curationRunEvents)
        .where(
          and(
            eq(curationRunEvents.organizationId, input.organizationId),
            eq(curationRunEvents.runId, input.runId)
          )
        )
        .orderBy(desc(curationRunEvents.createdAt))
        .limit(100);
    }),

  cancel: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const db = await requireDb();
      // Only a queued run can be cancelled cleanly. A running one holds a lease and
      // a warm engine process; let it finish rather than orphan the worker.
      const cancelled = await db
        .update(curationRuns)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(
          and(
            eq(curationRuns.organizationId, input.organizationId),
            eq(curationRuns.id, input.runId),
            eq(curationRuns.status, "queued")
          )
        )
        .returning({ id: curationRuns.id });

      if (!cancelled.length) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a queued run can be cancelled.",
        });
      }

      await db.insert(curationRunEvents).values({
        organizationId: input.organizationId,
        runId: input.runId,
        status: "cancelled",
        message: "Cancelled before a worker claimed it.",
        progressPercent: 0,
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.run_cancelled",
        entityType: "curation_run",
        entityId: input.runId,
        req: ctx.req,
      });
      return { success: true };
    }),
});

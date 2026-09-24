import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Request } from "express";
import { z } from "zod";
import { cases, curationBatches, curationRunEvents, curationRuns } from "../../drizzle/schema";
import {
  INSTITUTIONAL_CLASSIFICATIONS,
  institutionalClassForLabel,
} from "../../shared/curation/institutional";
import { isSingleVariantBatch, SINGLE_VARIANTS_BATCH } from "../../shared/curation/workbench";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { enqueueCurationRun } from "../domain/curationQueue";
import { ensureCurationWorker } from "../domain/curationWorker";
import { checkHumanGeneSymbol } from "../domain/geneSymbol";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const orgInput = z.object({ organizationId: z.number().int().positive() });

function variantInput(input: z.infer<typeof variantIntake>) {
  return {
    gene: input.gene,
    hgvsC: input.hgvsC,
    transcript: input.transcript || null,
    hgvsP: input.hgvsP || null,
    clinicalNotes: input.clinicalNotes || null,
    labId: input.labId || null,
    externalCaseId: input.externalCaseId || null,
    pmids: input.pmids || null,
    referenceBuild: "GRCh38" as const,
    runLiterature: true,
  };
}

const variantIntake = z.object({
  gene: z.string().trim().min(1).max(80),
  hgvsC: z.string().trim().min(3).max(255),
  transcript: z.string().trim().max(120).optional(),
  hgvsP: z.string().trim().max(255).optional(),
  labId: z.string().trim().max(120).optional(),
  externalCaseId: z.string().trim().max(120).optional(),
  pmids: z.string().trim().max(500).optional(),
  clinicalNotes: z.string().trim().max(4000).optional(),
});

const entryColumns = {
  id: curationRuns.id,
  batchId: curationRuns.batchId,
  status: curationRuns.status,
  input: curationRuns.input,
  summary: curationRuns.summary,
  institutionalLabel: curationRuns.institutionalLabel,
  institutionalClass: curationRuns.institutionalClass,
  error: curationRuns.error,
  caseId: curationRuns.caseId,
  queuedAt: curationRuns.queuedAt,
  startedAt: curationRuns.startedAt,
  completedAt: curationRuns.completedAt,
};

async function requireKnownGene(gene: string) {
  const result = await checkHumanGeneSymbol(gene);
  if (!result.ok) throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
  return result.symbol;
}

async function requireBatch(organizationId: number, batchId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(curationBatches)
    .where(and(eq(curationBatches.organizationId, organizationId), eq(curationBatches.id, batchId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Batch not found" });
  return rows[0];
}

type ReusedAnalysis = {
  sourceRunId: number;
  kind: "case" | "batch" | "single";
  label: string;
  batchId: number | null;
  caseId: number | null;
};

/** Latest succeeded analysis of the same gene and HGVSc in this organization. */
async function findCompletedAnalysis(organizationId: number, gene: string, hgvsC: string) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: curationRuns.id,
      batchId: curationRuns.batchId,
      caseId: curationRuns.caseId,
      documentKey: curationRuns.documentKey,
      documentHash: curationRuns.documentHash,
      rawKey: curationRuns.rawKey,
      rawHash: curationRuns.rawHash,
      summary: curationRuns.summary,
      engineVersion: curationRuns.engineVersion,
      contractVersion: curationRuns.contractVersion,
      timings: curationRuns.timings,
      completedAt: curationRuns.completedAt,
      startedAt: curationRuns.startedAt,
      attempt: curationRuns.attempt,
      batchName: curationBatches.name,
      caseNumber: cases.caseNumber,
    })
    .from(curationRuns)
    .leftJoin(
      curationBatches,
      and(eq(curationBatches.id, curationRuns.batchId), eq(curationBatches.organizationId, curationRuns.organizationId))
    )
    .leftJoin(cases, and(eq(cases.id, curationRuns.caseId), eq(cases.organizationId, curationRuns.organizationId)))
    .where(
      and(
        eq(curationRuns.organizationId, organizationId),
        eq(curationRuns.status, "succeeded"),
        sql`${curationRuns.documentKey} is not null`,
        sql`lower(${curationRuns.input}->>'gene') = ${gene.trim().toLowerCase()}`,
        sql`lower(${curationRuns.input}->>'hgvsC') = ${hgvsC.trim().toLowerCase()}`
      )
    )
    .orderBy(desc(curationRuns.completedAt))
    .limit(1);
  return rows[0] ?? null;
}

function reusedPlace(source: NonNullable<Awaited<ReturnType<typeof findCompletedAnalysis>>>): ReusedAnalysis {
  if (source.batchId && source.batchName && !isSingleVariantBatch(source.batchName)) {
    return { sourceRunId: source.id, kind: "batch", label: source.batchName, batchId: source.batchId, caseId: null };
  }
  if (source.caseId && source.caseNumber && !source.batchId) {
    return { sourceRunId: source.id, kind: "case", label: source.caseNumber, batchId: null, caseId: source.caseId };
  }
  if (source.batchId) {
    return { sourceRunId: source.id, kind: "single", label: "Single variants", batchId: source.batchId, caseId: null };
  }
  return {
    sourceRunId: source.id,
    kind: source.caseNumber ? "case" : "single",
    label: source.caseNumber || "Single variant",
    batchId: source.batchId,
    caseId: source.caseId,
  };
}

/** Store a new entry that points at an existing document instead of queueing the classifier. */
async function reuseCompletedAnalysis(args: {
  organizationId: number;
  batchId: number;
  requestedBy: number;
  input: {
    gene: string;
    hgvsC: string;
    transcript?: string | null;
    hgvsP?: string | null;
    clinicalNotes?: string | null;
    labId?: string | null;
    externalCaseId?: string | null;
    pmids?: string | null;
    referenceBuild: "GRCh38";
    runLiterature: boolean;
  };
}) {
  const source = await findCompletedAnalysis(args.organizationId, args.input.gene, args.input.hgvsC);
  if (!source?.documentKey) return null;
  const place = reusedPlace(source);
  const where =
    place.kind === "batch" ? `batch ${place.label}` : place.kind === "case" ? `case ${place.label}` : "Single variants";
  const db = await requireDb();
  const inserted = await db
    .insert(curationRuns)
    .values({
      organizationId: args.organizationId,
      batchId: args.batchId,
      input: {
        gene: args.input.gene,
        hgvsC: args.input.hgvsC,
        transcript: args.input.transcript || null,
        hgvsP: args.input.hgvsP || null,
        clinicalNotes: args.input.clinicalNotes || null,
        labId: args.input.labId || null,
        externalCaseId: args.input.externalCaseId || null,
        pmids: args.input.pmids || null,
        referenceBuild: "GRCh38",
        runLiterature: true,
      },
      status: "succeeded",
      priority: 0,
      requestedBy: args.requestedBy,
      documentKey: source.documentKey,
      documentHash: source.documentHash,
      rawKey: source.rawKey,
      rawHash: source.rawHash,
      summary: source.summary,
      engineVersion: source.engineVersion,
      contractVersion: source.contractVersion,
      timings: source.timings,
      attempt: source.attempt,
      startedAt: source.startedAt,
      completedAt: source.completedAt ?? new Date(),
    })
    .returning({ id: curationRuns.id });
  const id = inserted[0]!.id;
  await db.insert(curationRunEvents).values({
    organizationId: args.organizationId,
    runId: id,
    status: "succeeded",
    message: `Reused the completed analysis from ${where}.`,
    progressPercent: 100,
  });
  return { id, reused: place };
}

async function ensureSingleVariantsBatch(organizationId: number, userId: number) {
  const db = await requireDb();
  const existing = await db
    .select()
    .from(curationBatches)
    .where(
      and(
        eq(curationBatches.organizationId, organizationId),
        eq(curationBatches.name, SINGLE_VARIANTS_BATCH)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0];
  try {
    const inserted = await db
      .insert(curationBatches)
      .values({ organizationId, name: SINGLE_VARIANTS_BATCH, createdBy: userId })
      .returning();
    return inserted[0]!;
  } catch {
    const again = await db
      .select()
      .from(curationBatches)
      .where(
        and(
          eq(curationBatches.organizationId, organizationId),
          eq(curationBatches.name, SINGLE_VARIANTS_BATCH)
        )
      )
      .limit(1);
    if (again[0]) return again[0];
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not open the Single variants batch" });
  }
}

async function requeueSucceeded(organizationId: number, scope: SQL) {
  const db = await requireDb();
  try {
    return await db
      .update(curationRuns)
      .set({
        priority: 100,
        status: "queued",
        attempt: 0,
        error: null,
        completedAt: null,
        startedAt: null,
        workerId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        queuedAt: new Date(),
      })
      .where(and(eq(curationRuns.organizationId, organizationId), eq(curationRuns.status, "succeeded"), scope))
      .returning({ id: curationRuns.id });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "23505") {
      throw new TRPCError({ code: "CONFLICT", message: "That variant is already queued or running." });
    }
    throw error;
  }
}

async function startRequeue(organizationId: number, userId: number, released: { id: number }[], req: Request) {
  const db = await requireDb();
  await db.insert(curationRunEvents).values(
    released.map(row => ({
      organizationId,
      runId: row.id,
      status: "queued",
      message: "Re-queued for another analysis.",
      progressPercent: 0,
    }))
  );
  await writeAuditEvent({
    organizationId,
    actorUserId: userId,
    action: "curation.run_requeued",
    entityType: "curation_run",
    entityId: released[0]!.id,
    after: { runIds: released.map(row => row.id) },
    req,
  });
  try {
    const worker = ensureCurationWorker();
    return { released: released.length, workerStarted: !worker.alreadyRunning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the classifier.";
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
}

export const workbenchRouter = router({
  checkGene: protectedProcedure
    .input(z.object({ gene: z.string().trim().min(1).max(80) }))
    .query(async ({ input }) => checkHumanGeneSymbol(input.gene)),

  listBatches: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
    await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
    const db = await requireDb();
    return db
      .select()
      .from(curationBatches)
      .where(eq(curationBatches.organizationId, input.organizationId))
      .orderBy(asc(curationBatches.id));
  }),

  createBatch: protectedProcedure
    .input(orgInput.extend({ name: z.string().trim().min(1).max(160) }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const db = await requireDb();
      const inserted = await db
        .insert(curationBatches)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          createdBy: ctx.user.id,
        })
        .returning({ id: curationBatches.id });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.batch_created",
        entityType: "curation_batch",
        entityId: inserted[0]!.id,
        after: { name: input.name },
        req: ctx.req,
      });
      return { id: inserted[0]!.id };
    }),

  renameBatch: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive(), name: z.string().trim().min(1).max(160) }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const batch = await requireBatch(input.organizationId, input.batchId);
      if (batch.name === SINGLE_VARIANTS_BATCH || input.name === SINGLE_VARIANTS_BATCH) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The Single variants batch keeps its own name." });
      }
      if (input.name === batch.name) return { id: batch.id, name: batch.name };
      const db = await requireDb();
      try {
        await db
          .update(curationBatches)
          .set({ name: input.name })
          .where(and(eq(curationBatches.id, batch.id), eq(curationBatches.organizationId, input.organizationId)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
        if (`${message}\n${cause}`.includes("curation_batches_org_name_uq") || `${message}\n${cause}`.includes("23505")) {
          throw new TRPCError({ code: "CONFLICT", message: "A batch with that name already exists." });
        }
        throw error;
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.batch_renamed",
        entityType: "curation_batch",
        entityId: batch.id,
        before: { name: batch.name },
        after: { name: input.name },
        req: ctx.req,
      });
      return { id: batch.id, name: input.name };
    }),

  getBatch: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const batch = await requireBatch(input.organizationId, input.batchId);
      const db = await requireDb();
      const entries = await db
        .select(entryColumns)
        .from(curationRuns)
        .where(
          and(
            eq(curationRuns.organizationId, input.organizationId),
            eq(curationRuns.batchId, input.batchId)
          )
        )
        .orderBy(asc(curationRuns.id));
      return { batch, entries };
    }),

  /** Every workbench entry, across batches, for the Variants list. */
  listEntries: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
    await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
    const db = await requireDb();
    return db
      .select({
        ...entryColumns,
        batchName: curationBatches.name,
        caseNumber: cases.caseNumber,
      })
      .from(curationRuns)
      .leftJoin(
        curationBatches,
        and(
          eq(curationBatches.id, curationRuns.batchId),
          eq(curationBatches.organizationId, curationRuns.organizationId)
        )
      )
      .leftJoin(
        cases,
        and(eq(cases.id, curationRuns.caseId), eq(cases.organizationId, curationRuns.organizationId))
      )
      .where(eq(curationRuns.organizationId, input.organizationId))
      .orderBy(asc(curationRuns.id));
  }),

  addEntry: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive() }).merge(variantIntake))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      await requireBatch(input.organizationId, input.batchId);
      const intake = variantInput({ ...input, gene: await requireKnownGene(input.gene) });
      const copied = await reuseCompletedAnalysis({
        organizationId: input.organizationId,
        batchId: input.batchId,
        requestedBy: ctx.user.id,
        input: intake,
      });
      if (copied) {
        await writeAuditEvent({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          action: "curation.batch_entry_reused",
          entityType: "curation_run",
          entityId: copied.id,
          after: { batchId: input.batchId, gene: input.gene, hgvsC: input.hgvsC, sourceRunId: copied.reused.sourceRunId },
          req: ctx.req,
        });
        return { id: copied.id, batchId: input.batchId, reused: copied.reused };
      }
      const { id } = await enqueueCurationRun({
        organizationId: input.organizationId,
        batchId: input.batchId,
        variantId: null,
        input: intake,
        // Negative priority stays Queued and is invisible to the worker until Run batch.
        priority: -1,
        requestedBy: ctx.user.id,
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.batch_entry_queued",
        entityType: "curation_run",
        entityId: id,
        after: { batchId: input.batchId, gene: input.gene, hgvsC: input.hgvsC },
        req: ctx.req,
      });
      return { id, batchId: input.batchId, reused: null };
    }),

  /** Classify one variant into the shared Single variants batch. */
  runSingle: protectedProcedure
    .input(orgInput.merge(variantIntake))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const batch = await ensureSingleVariantsBatch(input.organizationId, ctx.user.id);
      const intake = variantInput({ ...input, gene: await requireKnownGene(input.gene) });
      const copied = await reuseCompletedAnalysis({
        organizationId: input.organizationId,
        batchId: batch.id,
        requestedBy: ctx.user.id,
        input: intake,
      });
      if (copied) {
        await writeAuditEvent({
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
          action: "curation.batch_entry_reused",
          entityType: "curation_run",
          entityId: copied.id,
          after: { batchId: batch.id, gene: input.gene, hgvsC: input.hgvsC, single: true, sourceRunId: copied.reused.sourceRunId },
          req: ctx.req,
        });
        return { id: copied.id, batchId: batch.id, reused: copied.reused };
      }
      const { id } = await enqueueCurationRun({
        organizationId: input.organizationId,
        batchId: batch.id,
        variantId: null,
        input: intake,
        priority: 100,
        requestedBy: ctx.user.id,
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.batch_entry_queued",
        entityType: "curation_run",
        entityId: id,
        after: { batchId: batch.id, gene: input.gene, hgvsC: input.hgvsC, single: true },
        req: ctx.req,
      });
      try {
        ensureCurationWorker();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the classifier.";
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
      return { id, batchId: batch.id, reused: null };
    }),

  /**
   * Release every queued or failed entry in one batch and start the classifier.
   * The worker claims a single run, so the first becomes Running and the rest stay Queued.
   */
  runBatch: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      await requireBatch(input.organizationId, input.batchId);
      const db = await requireDb();
      const released = await db
        .update(curationRuns)
        .set({
          priority: 100,
          status: "queued",
          error: null,
          completedAt: null,
        })
        .where(
          and(
            eq(curationRuns.organizationId, input.organizationId),
            eq(curationRuns.batchId, input.batchId),
            sql`status in ('queued', 'failed', 'cancelled')`
          )
        )
        .returning({ id: curationRuns.id });
      if (!released.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Nothing to run. Add a variant, or wait for the one already running.",
        });
      }
      try {
        const worker = ensureCurationWorker();
        return { released: released.length, workerStarted: !worker.alreadyRunning };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the classifier.";
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
    }),

  /** Queue a finished entry again and start the classifier. */
  rerunEntry: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const released = await requeueSucceeded(input.organizationId, eq(curationRuns.id, input.runId));
      if (!released.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a finished variant can be re-run." });
      }
      return startRequeue(input.organizationId, ctx.user.id, released, ctx.req);
    }),

  /** Queue every finished entry in a batch again and start the classifier. */
  rerunBatch: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      await requireBatch(input.organizationId, input.batchId);
      const released = await requeueSucceeded(input.organizationId, eq(curationRuns.batchId, input.batchId));
      if (!released.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This batch has no finished variants to re-run." });
      }
      return startRequeue(input.organizationId, ctx.user.id, released, ctx.req);
    }),

  /** Release one queued, failed, or cancelled entry and start the classifier. */
  releaseEntry: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const db = await requireDb();
      const released = await db
        .update(curationRuns)
        .set({
          priority: 100,
          status: "queued",
          error: null,
          completedAt: null,
        })
        .where(
          and(
            eq(curationRuns.organizationId, input.organizationId),
            eq(curationRuns.id, input.runId),
            sql`status in ('queued', 'failed', 'cancelled')`
          )
        )
        .returning({ id: curationRuns.id });
      if (!released.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This variant is not waiting to run.",
        });
      }
      try {
        const worker = ensureCurationWorker();
        return { workerStarted: !worker.alreadyRunning };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the classifier.";
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
    }),

  setInstitutional: protectedProcedure
    .input(
      orgInput.extend({
        runId: z.number().int().positive(),
        label: z.string().trim().max(80),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const label = input.label.trim();
      if (label && !INSTITUTIONAL_CLASSIFICATIONS.some(option => option.label === label)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown institutional classification" });
      }
      const cssClass = label ? institutionalClassForLabel(label) : null;
      const db = await requireDb();
      const updated = await db
        .update(curationRuns)
        .set({
          institutionalLabel: label || null,
          institutionalClass: cssClass,
        })
        .where(and(eq(curationRuns.organizationId, input.organizationId), eq(curationRuns.id, input.runId)))
        .returning({ id: curationRuns.id });
      if (!updated[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Curation run not found" });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.institutional_saved",
        entityType: "curation_run",
        entityId: input.runId,
        after: { label: label || null, class: cssClass },
        req: ctx.req,
      });
      return { label: label || "", class: cssClass || "vus" };
    }),

  /** Remove a workbench entry that is not currently running. Events cascade. */
  deleteEntry: protectedProcedure
    .input(orgInput.extend({ runId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const db = await requireDb();
      const rows = await db
        .select({ id: curationRuns.id, status: curationRuns.status, input: curationRuns.input })
        .from(curationRuns)
        .where(and(eq(curationRuns.organizationId, input.organizationId), eq(curationRuns.id, input.runId)))
        .limit(1);
      const entry = rows[0];
      if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "Entry not found" });
      if (entry.status === "loading" || entry.status === "running") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This variant is still running. Delete it after the classifier finishes or the run is cancelled.",
        });
      }
      await db
        .delete(curationRuns)
        .where(and(eq(curationRuns.organizationId, input.organizationId), eq(curationRuns.id, input.runId)));
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "curation.batch_entry_deleted",
        entityType: "curation_run",
        entityId: input.runId,
        after: { gene: entry.input.gene, hgvsC: entry.input.hgvsC, status: entry.status },
        req: ctx.req,
      });
      return { id: input.runId };
    }),
});

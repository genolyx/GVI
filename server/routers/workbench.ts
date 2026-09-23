import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { curationBatches, curationRuns } from "../../drizzle/schema";
import {
  INSTITUTIONAL_CLASSIFICATIONS,
  institutionalClassForLabel,
} from "../../shared/curation/institutional";
import { SINGLE_VARIANTS_BATCH } from "../../shared/curation/workbench";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { enqueueCurationRun } from "../domain/curationQueue";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const orgInput = z.object({ organizationId: z.number().int().positive() });

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
  queuedAt: curationRuns.queuedAt,
  startedAt: curationRuns.startedAt,
  completedAt: curationRuns.completedAt,
};

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

export const workbenchRouter = router({
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
      })
      .from(curationRuns)
      .innerJoin(
        curationBatches,
        and(
          eq(curationBatches.id, curationRuns.batchId),
          eq(curationBatches.organizationId, curationRuns.organizationId)
        )
      )
      .where(eq(curationRuns.organizationId, input.organizationId))
      .orderBy(asc(curationRuns.id));
  }),

  addEntry: protectedProcedure
    .input(orgInput.extend({ batchId: z.number().int().positive() }).merge(variantIntake))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      await requireBatch(input.organizationId, input.batchId);
      const { id } = await enqueueCurationRun({
        organizationId: input.organizationId,
        batchId: input.batchId,
        variantId: null,
        input: {
          gene: input.gene,
          hgvsC: input.hgvsC,
          transcript: input.transcript || null,
          hgvsP: input.hgvsP || null,
          clinicalNotes: input.clinicalNotes || null,
          labId: input.labId || null,
          externalCaseId: input.externalCaseId || null,
          pmids: input.pmids || null,
          referenceBuild: "GRCh38",
          runLiterature: true,
        },
        priority: 100,
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
      return { id, batchId: input.batchId };
    }),

  /** Classify one variant into the shared Single variants batch. */
  runSingle: protectedProcedure
    .input(orgInput.merge(variantIntake))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "curation:run");
      const batch = await ensureSingleVariantsBatch(input.organizationId, ctx.user.id);
      const { id } = await enqueueCurationRun({
        organizationId: input.organizationId,
        batchId: batch.id,
        variantId: null,
        input: {
          gene: input.gene,
          hgvsC: input.hgvsC,
          transcript: input.transcript || null,
          hgvsP: input.hgvsP || null,
          clinicalNotes: input.clinicalNotes || null,
          labId: input.labId || null,
          externalCaseId: input.externalCaseId || null,
          pmids: input.pmids || null,
          referenceBuild: "GRCh38",
          runLiterature: true,
        },
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
      return { id, batchId: batch.id };
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
});

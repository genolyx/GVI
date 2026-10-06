import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { germlineCasePanels, germlinePanels } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import {
  germlinePanelHash,
  parseGermlineBed,
  parseGermlineGeneText,
} from "../domain/germlinePanel";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";
import { writeAuditEvent } from "../domain/audit";

const code = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);

const panelContentInput = {
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  genomeBuild: z.enum(["GRCh37", "GRCh38"]).nullable(),
  genesText: z.string().max(500_000).optional(),
  bedText: z.string().max(20_000_000).optional(),
};

function panelContent(input: {
  genesText?: string;
  bedText?: string;
  genomeBuild: "GRCh37" | "GRCh38" | null;
}) {
  if (Boolean(input.genesText?.trim()) === Boolean(input.bedText?.trim())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Provide either a gene list or a BED file, not both.",
    });
  }
  let content;
  try {
    content = input.bedText?.trim()
      ? parseGermlineBed(input.bedText)
      : { genes: parseGermlineGeneText(input.genesText || ""), regions: null };
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: error instanceof Error ? error.message : "Invalid panel content.",
    });
  }
  if (content.regions && !input.genomeBuild) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A BED panel requires the reference build it was written against.",
    });
  }
  return content;
}

export const germlinePanelsRouter = router({
  list: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const db = await requireDb();
      const rows = await db
        .select()
        .from(germlinePanels)
        .where(eq(germlinePanels.organizationId, input.organizationId))
        .orderBy(asc(germlinePanels.name));
      return rows.map(row => ({
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        genomeBuild: row.genomeBuild,
        geneCount: row.genes.length,
        regionCount: row.regions?.length ?? 0,
        contentHash: row.contentHash,
      }));
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        code,
        ...panelContentInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:create"
      );
      const content = panelContent(input);
      const db = await requireDb();
      const rows = await db
        .insert(germlinePanels)
        .values({
          organizationId: input.organizationId,
          code: input.code,
          name: input.name,
          description: input.description || null,
          genes: content.genes,
          regions: content.regions,
          genomeBuild: input.genomeBuild,
          contentHash: germlinePanelHash(content, input.genomeBuild),
          createdBy: ctx.user.id,
        })
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "germline.panel.created",
        entityType: "germline_panel",
        entityId: rows[0].id,
        after: {
          code: rows[0].code,
          name: rows[0].name,
          geneCount: content.genes.length,
          regionCount: content.regions?.length ?? 0,
        },
        req: ctx.req,
      });
      return {
        id: rows[0].id,
        code: rows[0].code,
        geneCount: content.genes.length,
        regionCount: content.regions?.length ?? 0,
      };
    }),

  get: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        panelId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:read"
      );
      const db = await requireDb();
      const rows = await db
        .select()
        .from(germlinePanels)
        .where(
          and(
            eq(germlinePanels.id, input.panelId),
            eq(germlinePanels.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!rows[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Panel not found." });
      }
      return rows[0];
    }),

  update: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        panelId: z.number().int().positive(),
        ...panelContentInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:create"
      );
      const content = panelContent(input);
      const db = await requireDb();
      const existing = await db
        .select()
        .from(germlinePanels)
        .where(
          and(
            eq(germlinePanels.id, input.panelId),
            eq(germlinePanels.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!existing[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Gene list not found." });
      }
      const rows = await db
        .update(germlinePanels)
        .set({
          name: input.name,
          description: input.description || null,
          genes: content.genes,
          regions: content.regions,
          genomeBuild: input.genomeBuild,
          contentHash: germlinePanelHash(content, input.genomeBuild),
        })
        .where(
          and(
            eq(germlinePanels.id, input.panelId),
            eq(germlinePanels.organizationId, input.organizationId)
          )
        )
        .returning();
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "germline.panel.updated",
        entityType: "germline_panel",
        entityId: rows[0].id,
        before: {
          code: existing[0].code,
          name: existing[0].name,
          geneCount: existing[0].genes.length,
          regionCount: existing[0].regions?.length ?? 0,
        },
        after: {
          code: rows[0].code,
          name: rows[0].name,
          geneCount: content.genes.length,
          regionCount: content.regions?.length ?? 0,
        },
        req: ctx.req,
      });
      return {
        id: rows[0].id,
        code: rows[0].code,
        geneCount: content.genes.length,
        regionCount: content.regions?.length ?? 0,
      };
    }),

  remove: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        panelId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "case:create"
      );
      const db = await requireDb();
      const removed = await db.transaction(async tx => {
        await tx
          .update(germlineCasePanels)
          .set({ panelId: null })
          .where(
            and(
              eq(germlineCasePanels.panelId, input.panelId),
              eq(germlineCasePanels.organizationId, input.organizationId)
            )
          );
        return tx
          .delete(germlinePanels)
          .where(
            and(
              eq(germlinePanels.id, input.panelId),
              eq(germlinePanels.organizationId, input.organizationId)
            )
          )
          .returning({ id: germlinePanels.id, name: germlinePanels.name });
      });
      if (!removed[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Gene list not found." });
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "germline.panel.deleted",
        entityType: "germline_panel",
        entityId: removed[0].id,
        after: { name: removed[0].name },
        req: ctx.req,
      });
      return { id: removed[0].id, name: removed[0].name };
    }),
});

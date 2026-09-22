import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { projects } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

export const projectsRouter = router({
  list: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      return db
        .select()
        .from(projects)
        .where(and(eq(projects.organizationId, input.organizationId), eq(projects.status, "active")))
        .orderBy(desc(projects.createdAt));
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        name: z.string().trim().min(2).max(160),
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]+$/).max(40),
        description: z.string().trim().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "project:create");
      const db = await requireDb();
      const result = await db.insert(projects).values({
        organizationId: input.organizationId,
        name: input.name,
        code: input.code,
        description: input.description || null,
        createdBy: ctx.user.id,
      }).returning({ id: projects.id });
      const id = result[0].id;
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "project.created",
        entityType: "project",
        entityId: id,
        after: { name: input.name, code: input.code },
        req: ctx.req,
      });
      return { id };
    }),

  get: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      const rows = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId)
          )
        )
        .limit(1);
      return rows[0] ?? null;
    }),
});

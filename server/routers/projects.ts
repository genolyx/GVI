import { and, count, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { cases, projects } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const projectCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]+$/)
  .max(40);
const projectName = z.string().trim().min(2).max(160);

function isProjectCodeConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  const combined = `${message}\n${cause}`;
  return (
    combined.includes("projects_org_code_uq") ||
    combined.includes("23505")
  );
}

export const projectsRouter = router({
  list: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "case:read");
      const db = await requireDb();
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.organizationId, input.organizationId), eq(projects.status, "active")))
        .orderBy(desc(projects.createdAt));
      const counts = await db
        .select({
          projectId: cases.projectId,
          caseCount: count(),
        })
        .from(cases)
        .where(eq(cases.organizationId, input.organizationId))
        .groupBy(cases.projectId);
      const caseCountByProject = new Map(
        counts.map(row => [row.projectId, row.caseCount])
      );
      return rows.map(row => ({
        ...row,
        caseCount: Number(caseCountByProject.get(row.id) ?? 0),
      }));
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        name: projectName,
        code: projectCode,
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

  update: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive(),
        name: projectName,
        code: projectCode,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "project:manage"
      );
      const db = await requireDb();
      const existing = await db
        .select({ id: projects.id, name: projects.name, code: projects.code })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!existing[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
      }
      try {
        await db
          .update(projects)
          .set({
            name: input.name,
            code: input.code,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.organizationId, input.organizationId)
            )
          );
      } catch (error) {
        if (isProjectCodeConflict(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Another project in this organization already uses that code.",
          });
        }
        throw error;
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "project.updated",
        entityType: "project",
        entityId: input.projectId,
        before: { name: existing[0].name, code: existing[0].code },
        after: { name: input.name, code: input.code },
        req: ctx.req,
      });
      return { ok: true };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        projectId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "project:manage"
      );
      const db = await requireDb();
      const existing = await db
        .select({ id: projects.id, name: projects.name, code: projects.code })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!existing[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
      }
      const attached = await db
        .select({ caseCount: count() })
        .from(cases)
        .where(
          and(
            eq(cases.projectId, input.projectId),
            eq(cases.organizationId, input.organizationId)
          )
        );
      const caseCount = Number(attached[0]?.caseCount ?? 0);
      if (caseCount > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `This project still has ${caseCount} ${caseCount === 1 ? "case" : "cases"}. Delete is available after those cases are removed.`,
        });
      }
      await db
        .delete(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.organizationId, input.organizationId)
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "project.deleted",
        entityType: "project",
        entityId: input.projectId,
        before: { name: existing[0].name, code: existing[0].code },
        req: ctx.req,
      });
      return { ok: true };
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

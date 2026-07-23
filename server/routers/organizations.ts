import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  auditEvents,
  organizationInvites,
  organizationMembers,
  organizations,
  projects,
  users,
} from "../../drizzle/schema";
import { ROLE_PERMISSIONS, ORGANIZATION_ROLES } from "../../shared/permissions";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const roleSchema = z.enum(ORGANIZATION_ROLES);

export const organizationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
        dataRegion: organizations.dataRegion,
        isolationMode: organizations.isolationMode,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(
        and(
          eq(organizationMembers.userId, ctx.user.id),
          eq(organizationMembers.status, "active"),
          eq(organizations.status, "active")
        )
      );
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(160),
        slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
        dataRegion: z.string().trim().min(2).max(32).default("KR"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const result = await db.transaction(async tx => {
        const insertResult = await tx.insert(organizations).values({
          name: input.name,
          slug: input.slug,
          dataRegion: input.dataRegion,
          createdBy: ctx.user.id,
        });
        const organizationId = Number(insertResult[0].insertId);
        await tx.insert(organizationMembers).values({
          organizationId,
          userId: ctx.user.id,
          role: "administrator",
          status: "active",
        });
        return organizationId;
      });
      await writeAuditEvent({
        organizationId: result,
        actorUserId: ctx.user.id,
        action: "organization.created",
        entityType: "organization",
        entityId: result,
        after: { name: input.name, slug: input.slug, role: "administrator" },
        req: ctx.req,
      });
      return { id: result };
    }),

  securityContext: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const membership = await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "security:view"
      );
      const db = await requireDb();
      const accessibleProjects = await db
        .select({ id: projects.id, name: projects.name, code: projects.code })
        .from(projects)
        .where(and(eq(projects.organizationId, input.organizationId), eq(projects.status, "active")));
      return {
        organization: {
          id: membership.organizationId,
          name: membership.organizationName,
          slug: membership.organizationSlug,
          dataRegion: membership.dataRegion,
          isolationMode: membership.isolationMode,
        },
        role: membership.role,
        permissions: membership.permissions,
        accessibleProjects,
        controls: [
          { key: "tenant-column", label: "모든 임상 레코드 organizationId 강제", state: "enforced" as const },
          { key: "composite-fk", label: "부모–자식 동일 조직 복합 외래키", state: "enforced" as const },
          { key: "server-rbac", label: "서버 액션 단위 RBAC", state: "enforced" as const },
          { key: "s3-prefix", label: "조직·케이스 S3 경로 격리", state: "enforced" as const },
          { key: "audit", label: "변경 이벤트 append-only 감사", state: "enforced" as const },
        ],
      };
    }),

  members: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "member:manage");
      const db = await requireDb();
      return db
        .select({
          id: organizationMembers.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: organizationMembers.role,
          status: organizationMembers.status,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, input.organizationId));
    }),

  invite: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        email: z.string().trim().toLowerCase().email(),
        role: roleSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "member:invite");
      const db = await requireDb();
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const insertResult = await db.insert(organizationInvites).values({
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        tokenHash,
        expiresAt,
        createdBy: ctx.user.id,
      });
      const id = Number(insertResult[0].insertId);
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "member.invited",
        entityType: "organization_invite",
        entityId: id,
        after: { email: input.email, role: input.role, expiresAt: expiresAt.toISOString() },
        req: ctx.req,
      });
      return { id, token, expiresAt };
    }),

  invites: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "member:manage");
      const db = await requireDb();
      return db
        .select({
          id: organizationInvites.id,
          email: organizationInvites.email,
          role: organizationInvites.role,
          expiresAt: organizationInvites.expiresAt,
          acceptedAt: organizationInvites.acceptedAt,
          revokedAt: organizationInvites.revokedAt,
          createdAt: organizationInvites.createdAt,
        })
        .from(organizationInvites)
        .where(eq(organizationInvites.organizationId, input.organizationId))
        .orderBy(desc(organizationInvites.createdAt));
    }),

  revokeInvite: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), inviteId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "member:manage");
      const db = await requireDb();
      const rows = await db
        .select()
        .from(organizationInvites)
        .where(and(eq(organizationInvites.id, input.inviteId), eq(organizationInvites.organizationId, input.organizationId)))
        .limit(1);
      const invite = rows[0];
      if (!invite) throw new TRPCError({ code: "NOT_FOUND" });
      if (invite.acceptedAt || invite.revokedAt) throw new TRPCError({ code: "CONFLICT", message: "Invitation is no longer pending" });
      const revokedAt = new Date();
      await db
        .update(organizationInvites)
        .set({ revokedAt })
        .where(and(eq(organizationInvites.id, input.inviteId), eq(organizationInvites.organizationId, input.organizationId)));
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "member.invite_revoked",
        entityType: "organization_invite",
        entityId: input.inviteId,
        before: { email: invite.email, role: invite.role },
        after: { revokedAt: revokedAt.toISOString() },
        req: ctx.req,
      });
      return { success: true };
    }),

  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string().min(20) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const rows = await db
        .select()
        .from(organizationInvites)
        .where(eq(organizationInvites.tokenHash, tokenHash))
        .limit(1);
      const invite = rows[0];
      if (
        !invite ||
        invite.acceptedAt ||
        invite.revokedAt ||
        invite.expiresAt.getTime() <= Date.now() ||
        !ctx.user.email ||
        invite.email.toLowerCase() !== ctx.user.email.toLowerCase()
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invitation is invalid or expired" });
      }
      await db.transaction(async tx => {
        await tx.insert(organizationMembers).values({
          organizationId: invite.organizationId,
          userId: ctx.user.id,
          role: invite.role,
          status: "active",
          invitedBy: invite.createdBy,
        });
        await tx
          .update(organizationInvites)
          .set({ acceptedAt: new Date() })
          .where(and(eq(organizationInvites.id, invite.id), eq(organizationInvites.organizationId, invite.organizationId)));
      });
      await writeAuditEvent({
        organizationId: invite.organizationId,
        actorUserId: ctx.user.id,
        action: "member.invite_accepted",
        entityType: "organization_member",
        entityId: ctx.user.id,
        after: { role: invite.role, email: invite.email },
        req: ctx.req,
      });
      return { organizationId: invite.organizationId };
    }),

  updateMemberRole: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        memberId: z.number().int().positive(),
        role: roleSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "member:manage");
      const db = await requireDb();
      const existing = await db
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.id, input.memberId),
            eq(organizationMembers.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .update(organizationMembers)
        .set({ role: input.role })
        .where(
          and(
            eq(organizationMembers.id, input.memberId),
            eq(organizationMembers.organizationId, input.organizationId)
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "member.role_changed",
        entityType: "organization_member",
        entityId: input.memberId,
        before: { role: existing[0].role },
        after: { role: input.role },
        req: ctx.req,
      });
      return { success: true };
    }),

  audit: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        entityType: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "audit:view");
      const db = await requireDb();
      const conditions = [eq(auditEvents.organizationId, input.organizationId)];
      if (input.entityType) conditions.push(eq(auditEvents.entityType, input.entityType));
      return db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt))
        .limit(input.limit);
    }),

  permissionCatalog: protectedProcedure.query(() => ({
    roles: ORGANIZATION_ROLES,
    permissions: ROLE_PERMISSIONS,
  })),
});

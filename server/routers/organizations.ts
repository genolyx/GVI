import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
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
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
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

  /**
   * Provision a new organization workspace.
   * Restricted to platform admins (users.role = admin), not org-scoped administrators.
   * The creator becomes the first organization administrator.
   */
  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(160),
        slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
        dataRegion: z.string().trim().min(2).max(32).default("KR"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      let result: number;
      try {
        result = await db.transaction(async tx => {
          const insertResult = await tx.insert(organizations).values({
            name: input.name,
            slug: input.slug,
            dataRegion: input.dataRegion,
            createdBy: ctx.user.id,
          }).returning({ id: organizations.id });
          const organizationId = insertResult[0].id;
          await tx.insert(organizationMembers).values({
            organizationId,
            userId: ctx.user.id,
            role: "administrator",
            status: "active",
          });
          return organizationId;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const causeMessage =
          error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
        const combined = `${message}\n${causeMessage}`;
        // Postgres unique violation on organizations.slug (SQLSTATE 23505)
        if (
          combined.includes("organizations_slug_uq") ||
          combined.includes("Duplicate entry") ||
          /ER_DUP_ENTRY|errno:\s*1062/i.test(combined)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              `The organization identifier "${input.slug}" is already taken. ` +
              "If you belong to an existing organization, ask an administrator to invite your email " +
              "(Organization → Invite member). Do not create a second workspace with the same name.",
          });
        }
        throw error;
      }
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
          { key: "tenant-column", label: "organizationId enforced on all clinical records", state: "enforced" as const },
          { key: "composite-fk", label: "Parent–child composite foreign key for same organization", state: "enforced" as const },
          { key: "server-rbac", label: "Server-side action-level RBAC", state: "enforced" as const },
          { key: "s3-prefix", label: "Organization & case S3 path isolation", state: "enforced" as const },
          { key: "audit", label: "Append-only audit for change events", state: "enforced" as const },
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
      }).returning({ id: organizationInvites.id });
      const id = insertResult[0].id;
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

  getInvite: publicProcedure
    .input(z.object({ token: z.string().min(20) }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const rows = await db
        .select({
          email: organizationInvites.email,
          role: organizationInvites.role,
          expiresAt: organizationInvites.expiresAt,
          acceptedAt: organizationInvites.acceptedAt,
          revokedAt: organizationInvites.revokedAt,
          organizationId: organizationInvites.organizationId,
          organizationName: organizations.name,
          organizationSlug: organizations.slug,
        })
        .from(organizationInvites)
        .innerJoin(organizations, eq(organizations.id, organizationInvites.organizationId))
        .where(eq(organizationInvites.tokenHash, tokenHash))
        .limit(1);
      const invite = rows[0];
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
      }
      const status = invite.acceptedAt
        ? ("accepted" as const)
        : invite.revokedAt
          ? ("revoked" as const)
          : invite.expiresAt.getTime() <= Date.now()
            ? ("expired" as const)
            : ("pending" as const);
      return {
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        organizationId: invite.organizationId,
        organizationName: invite.organizationName,
        organizationSlug: invite.organizationSlug,
        status,
      };
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
      if (!invite || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invitation is invalid or expired. Ask an administrator to send a new invite.",
        });
      }
      if (!ctx.user.email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Your account has no email. Sign in with the Google account that received the invite.",
        });
      }
      if (invite.email.toLowerCase() !== ctx.user.email.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            `This invite was sent to ${invite.email}. You are signed in as ${ctx.user.email}. ` +
            "Sign out and sign in with the invited Google account.",
        });
      }

      const existing = await db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, invite.organizationId),
            eq(organizationMembers.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (existing[0]) {
        if (!invite.acceptedAt) {
          await db
            .update(organizationInvites)
            .set({ acceptedAt: new Date() })
            .where(
              and(
                eq(organizationInvites.id, invite.id),
                eq(organizationInvites.organizationId, invite.organizationId)
              )
            );
        }
        return { organizationId: invite.organizationId, alreadyMember: true };
      }

      if (invite.acceptedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This invitation has already been accepted.",
        });
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
          .where(
            and(
              eq(organizationInvites.id, invite.id),
              eq(organizationInvites.organizationId, invite.organizationId)
            )
          );
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
      return { organizationId: invite.organizationId, alreadyMember: false };
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
      if (existing[0].role === "administrator" && input.role !== "administrator") {
        const adminCount = await db
          .select({ count: count() })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.role, "administrator"),
              eq(organizationMembers.status, "active")
            )
          );
        if ((adminCount[0]?.count || 0) <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot remove the last administrator",
          });
        }
      }
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

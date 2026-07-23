import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { organizationMembers, organizations } from "../../drizzle/schema";
import {
  ROLE_PERMISSIONS,
  roleHasPermission,
  type OrganizationRole,
  type Permission,
} from "../../shared/permissions";
import { getDb } from "../db";

export async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database is unavailable" });
  }
  return db;
}

export async function getMembership(userId: number, organizationId: number) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: organizationMembers.id,
      organizationId: organizationMembers.organizationId,
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      organizationStatus: organizations.status,
      dataRegion: organizations.dataRegion,
      isolationMode: organizations.isolationMode,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.status, "active"),
        eq(organizations.status, "active")
      )
    )
    .limit(1);
  return rows[0];
}

export async function requireOrganizationPermission(
  userId: number,
  organizationId: number,
  permission: Permission
) {
  const membership = await getMembership(userId, organizationId);
  if (!membership) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Organization resource not found" });
  }
  if (!roleHasPermission(membership.role as OrganizationRole, permission)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${permission}` });
  }
  return {
    ...membership,
    permissions: ROLE_PERMISSIONS[membership.role as OrganizationRole],
  };
}

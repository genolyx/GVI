import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { organizationMembers, organizations, users } from "../../drizzle/schema";
import {
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ORGANIZATION_ROLE,
  isSuperAdminRole,
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
  const db = await requireDb();
  const userRows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (isSuperAdminRole(userRows[0]?.role)) {
    const elevated = await superAdminOrganizationAccess(userId, organizationId);
    if (!elevated) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organization resource not found" });
    }
    if (!ROLE_PERMISSIONS.administrator.includes(permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${permission}` });
    }
    return elevated;
  }

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

/** Full organization access without inserting an organization_members row. */
async function superAdminOrganizationAccess(userId: number, organizationId: number) {
  const db = await requireDb();
  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
      dataRegion: organizations.dataRegion,
      isolationMode: organizations.isolationMode,
    })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.status, "active")))
    .limit(1);
  const org = orgRows[0];
  if (!org) return null;
  const membership = await getMembership(userId, organizationId);
  return {
    id: membership?.id ?? 0,
    organizationId: org.id,
    userId,
    role: SUPER_ADMIN_ORGANIZATION_ROLE,
    status: "active" as const,
    organizationName: org.name,
    organizationSlug: org.slug,
    organizationStatus: org.status,
    dataRegion: org.dataRegion,
    isolationMode: org.isolationMode,
    permissions: ROLE_PERMISSIONS.administrator,
  };
}

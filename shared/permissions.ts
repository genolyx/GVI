export const ORGANIZATION_ROLES = [
  "administrator",
  "analyst",
  "clinician",
  "viewer",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Switcher label for a platform super administrator.
 * This is not stored on organization_members and is not an invite role.
 */
export const SUPER_ADMIN_ORGANIZATION_ROLE = "super_administrator" as const;

export type OrganizationAccessRole = OrganizationRole | typeof SUPER_ADMIN_ORGANIZATION_ROLE;

export function isPlatformAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin";
}

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === "super_admin";
}

/**
 * A platform admin can open another workspace. A new account with no membership
 * creates the first one and becomes its administrator. An invited account joins
 * through the invite instead of opening a second workspace.
 */
export function canProvisionOrganization(input: {
  platformAdmin: boolean;
  membershipCount: number;
}): { ok: true } | { ok: false; message: string } {
  if (input.platformAdmin || input.membershipCount === 0) return { ok: true };
  return {
    ok: false,
    message:
      "This account already belongs to an organization. Open the invite link, or ask an administrator to invite your email.",
  };
}

export const PERMISSIONS = [
  "organization:manage",
  "member:invite",
  "member:manage",
  "project:create",
  "project:manage",
  "case:create",
  "case:read",
  "case:edit",
  "file:upload",
  "variant:read",
  // Queueing engine curation is metered separately from editing an interpretation:
  // each run costs minutes of a warm worker and external API quota.
  "curation:run",
  "interpretation:edit",
  "interpretation:approve",
  "report:draft",
  "report:review",
  "report:sign",
  "report:read",
  "audit:view",
  "security:view",
  "data:export",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  administrator: PERMISSIONS,
  analyst: [
    "project:create",
    "case:create",
    "case:read",
    "case:edit",
    "file:upload",
    "variant:read",
    "curation:run",
    "interpretation:edit",
    "report:draft",
    "report:read",
    "security:view",
  ],
  clinician: [
    "case:read",
    "case:edit",
    "variant:read",
    "curation:run",
    "interpretation:edit",
    "interpretation:approve",
    "report:draft",
    "report:review",
    "report:sign",
    "report:read",
    "audit:view",
    "security:view",
    "data:export",
  ],
  viewer: ["case:read", "variant:read", "report:read", "security:view"],
};

export function roleHasPermission(
  role: OrganizationRole,
  permission: Permission
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

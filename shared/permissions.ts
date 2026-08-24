export const ORGANIZATION_ROLES = [
  "administrator",
  "analyst",
  "clinician",
  "viewer",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

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
    "interpretation:edit",
    "report:draft",
    "report:read",
    "security:view",
  ],
  clinician: [
    "case:read",
    "case:edit",
    "variant:read",
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

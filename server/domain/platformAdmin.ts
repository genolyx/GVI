import { ENV } from "../_core/env";

/**
 * Platform admins can provision new organization workspaces.
 * This is distinct from organization-scoped `administrator` membership.
 *
 * Promotion source: PLATFORM_ADMIN_EMAILS (comma-separated), applied on login.
 */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ENV.platformAdminEmails.has(email.trim().toLowerCase());
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ENV.superAdminEmails.has(email.trim().toLowerCase());
}

/** Role written on login. Super administrator wins when an email is on both lists. */
export function platformRoleForEmail(
  email: string | null | undefined
): "super_admin" | "admin" | null {
  if (isSuperAdminEmail(email)) return "super_admin";
  if (isPlatformAdminEmail(email)) return "admin";
  return null;
}

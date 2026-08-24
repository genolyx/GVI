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

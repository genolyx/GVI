/**
 * A case, batch, or report id in the URL belongs to one organization.
 * Keeping it after an organization switch makes the next request look up that
 * id in the new organization, which returns "Case not found".
 */
export function pathAfterOrganizationChange(path: string): string | null {
  const pathname = path.split("?")[0]?.split("#")[0] ?? path;
  if (/^\/workbench\/\d+(?:\/|$)/.test(pathname)) return "/workbench";
  if (pathname.startsWith("/workbench/batches/")) return "/workbench";
  if (pathname === "/cases/new" || /^\/cases\/\d+(?:\/|$)/.test(pathname)) return "/cases";
  if (/^\/reports\/\d+(?:\/|$)/.test(pathname)) return "/reports";
  return null;
}

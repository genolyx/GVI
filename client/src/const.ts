export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Start Google (Gmail) OAuth login.
 * Call from an event handler or effect — never during render.
 * Optional `returnTo` must be a same-origin relative path (e.g. `/invite/...`).
 */
export const startLogin = (returnTo?: string) => {
  const url = new URL("/api/auth/google", window.location.origin);
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    url.searchParams.set("returnTo", returnTo);
  }
  window.location.href = url.toString();
};

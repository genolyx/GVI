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

/** True when local Dev Auth is on and Google OAuth is not configured. */
export const isDevAuthWithoutGoogle = () =>
  import.meta.env.VITE_DEV_AUTH === "true" && import.meta.env.VITE_GOOGLE_AUTH !== "true";

/**
 * Handle an unauthenticated API error: show Dev Login panel, or start Google OAuth.
 */
export const redirectForUnauth = () => {
  if (typeof window === "undefined") return;
  if (isDevAuthWithoutGoogle()) {
    window.location.href = "/";
    return;
  }
  startLogin();
};

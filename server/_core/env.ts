function parseEmailAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  /** OpenAI-compatible API base URL for copilot (e.g. https://api.openai.com). */
  llmApiUrl: process.env.LLM_API_URL ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  /** Optional override; default is derived from the request host. */
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
  /**
   * Platform admins (users.role = admin) who may create organizations.
   * Comma-separated emails; matched case-insensitively on login.
   */
  platformAdminEmails: parseEmailAllowlist(process.env.PLATFORM_ADMIN_EMAILS),
  /**
   * Super administrators (users.role = super_admin). They can open every
   * organization without a membership row. Comma-separated emails.
   */
  superAdminEmails: parseEmailAllowlist(process.env.SUPER_ADMIN_EMAILS),
  /** Shared secret presented by curation engine workers on /api/engine/v1/*. */
  engineWorkerToken: process.env.ENGINE_WORKER_TOKEN ?? "",
  /**
   * How long a claimed curation run stays leased. A worker heartbeats to extend it;
   * once it lapses the reaper requeues the run, so this bounds how long a crashed
   * worker can strand a variant.
   */
  engineLeaseSeconds: parsePositiveInt(process.env.ENGINE_LEASE_SECONDS, 900),
  /**
   * OncoKB API bearer token (academic registration at oncokb.org/api-access).
   * Without it, somatic refresh still runs CIViC and records `oncokb` as disabled.
   */
  oncokbToken: process.env.ONCOKB_TOKEN ?? "",
  /** Optional CIViC GraphQL key — lifts the anonymous 3 req/s cap. */
  civicApiKey: process.env.CIVIC_API_KEY ?? "",
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

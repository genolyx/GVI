function parseEmailAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseOncoKbMode(
  raw: string | undefined
): "disabled" | "demo" | "research" | "commercial" {
  const value = raw?.trim().toLowerCase();
  return value === "demo" || value === "research" || value === "commercial"
    ? value
    : "disabled";
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
  oncokbMode: parseOncoKbMode(process.env.ONCOKB_API_MODE),
  oncokbApiToken: process.env.ONCOKB_API_TOKEN ?? "",
  /** Legacy non-CDS path only; do not configure for the Somatic API adapter. */
  oncokbToken: process.env.ONCOKB_TOKEN ?? "",
  oncokbBaseUrl:
    process.env.ONCOKB_BASE_URL?.replace(/\/+$/, "") ||
    (process.env.ONCOKB_API_MODE?.trim().toLowerCase() === "demo"
      ? "https://demo.oncokb.org"
      : "https://www.oncokb.org"),
  oncokbBatchSize: parsePositiveInt(process.env.ONCOKB_BATCH_SIZE, 100),
  oncokbMaxConcurrency: parsePositiveInt(process.env.ONCOKB_MAX_CONCURRENCY, 3),
  oncokbRequestTimeoutSeconds: parsePositiveInt(
    process.env.ONCOKB_REQUEST_TIMEOUT_SECONDS,
    60
  ),
  oncokbRetryCount: parsePositiveInt(process.env.ONCOKB_RETRY_COUNT, 3),
  oncokbCacheTtlSeconds: parsePositiveInt(
    process.env.ONCOKB_CACHE_TTL_SECONDS,
    86400
  ),
  /** Optional CIViC GraphQL key — lifts the anonymous 3 req/s cap. */
  civicApiKey: process.env.CIVIC_API_KEY ?? "",
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

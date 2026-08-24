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
};

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MIN_TOKEN_LENGTH = 32;

let savedCache: { loaded: boolean; token: string | null } = {
  loaded: false,
  token: null,
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** `off` disables the file so tests keep using the environment only. */
export function partnerTokenPath(): string | null {
  const override = process.env.PARTNER_TOKEN_FILE?.trim();
  if (override === "off" || override === "-") return null;
  if (override) return override;
  const root =
    (process.env.VC_DATA_ROOT || "").trim() || path.join(os.homedir(), "gvi-data");
  return path.join(expandHome(root), "partner-api-token");
}

export const DEFAULT_PORTAL_URL = "http://localhost:8090";

export function partnerPortalUrlPath(): string | null {
  const override = process.env.PARTNER_PORTAL_URL_FILE?.trim();
  if (override === "off" || override === "-") return null;
  if (override) return override;
  const tokenFile = partnerTokenPath();
  if (!tokenFile) return null;
  return path.join(path.dirname(tokenFile), "partner-portal-url");
}

/** Portal origin. :8090 is the nginx prefix; the API process on :4000 has no /api prefix. */
export function portalPartnerHealthUrl(base: string): string {
  const trimmed = base.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/api")) return `${trimmed}/system/partner/health`;
  try {
    const parsed = new URL(trimmed);
    if (parsed.port === "4000") return `${trimmed}/system/partner/health`;
  } catch {
    return `${trimmed}/api/system/partner/health`;
  }
  return `${trimmed}/api/system/partner/health`;
}

function usable(value: string | null | undefined): string | null {
  const token = (value ?? "").trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

async function readSavedToken(): Promise<string | null> {
  if (savedCache.loaded) return savedCache.token;
  const file = partnerTokenPath();
  let token: string | null = null;
  if (file) {
    try {
      token = usable(await readFile(file, "utf8"));
    } catch {
      token = null;
    }
  }
  savedCache = { loaded: true, token };
  return token;
}

export async function resolvePartnerToken(): Promise<string | null> {
  return (await readSavedToken()) || usable(process.env.PARTNER_API_TOKEN);
}

export function previewPartnerToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length < 4) return "****";
  return `…${token.slice(-4)}`;
}

export async function partnerTokenStatus(): Promise<{
  configured: boolean;
  preview: string | null;
  source: "saved" | "env" | "none";
}> {
  const saved = await readSavedToken();
  const env = usable(process.env.PARTNER_API_TOKEN);
  const active = saved || env;
  return {
    configured: Boolean(active),
    preview: previewPartnerToken(active),
    source: saved ? "saved" : env ? "env" : "none",
  };
}

export async function savePartnerToken(token: string | null): Promise<void> {
  const file = partnerTokenPath();
  if (!file) throw new Error("Partner token storage is disabled");
  const trimmed = usable(token);
  if ((token ?? "").trim() && !trimmed) {
    throw new Error("GVC token must be at least 32 characters");
  }
  if (!trimmed) {
    await rm(file, { force: true });
    savedCache = { loaded: true, token: null };
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${trimmed}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  savedCache = { loaded: true, token: trimmed };
}

let portalUrlCache: { loaded: boolean; url: string } = { loaded: false, url: "" };

export async function readPortalUrl(): Promise<string> {
  if (portalUrlCache.loaded) return portalUrlCache.url;
  const file = partnerPortalUrlPath();
  let url = "";
  if (file) {
    try {
      url = (await readFile(file, "utf8")).trim().replace(/\/$/, "");
    } catch {
      url = "";
    }
  }
  portalUrlCache = { loaded: true, url };
  return url;
}

export async function savePortalUrl(url: string): Promise<void> {
  const file = partnerPortalUrlPath();
  if (!file) throw new Error("Portal URL storage is disabled");
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Portal URL must start with http:// or https://");
  }
  if (!trimmed) {
    await rm(file, { force: true });
    portalUrlCache = { loaded: true, url: "" };
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${trimmed}\n`, { encoding: "utf8", mode: 0o600 });
  portalUrlCache = { loaded: true, url: trimmed };
}

export async function checkPortalConnection(url?: string): Promise<{ ok: boolean; message: string }> {
  const token = await resolvePartnerToken();
  const base = (url ?? (await readPortalUrl()) ?? "").trim() || DEFAULT_PORTAL_URL;
  if (!token) return { ok: false, message: "Save a partner token first." };
  try {
    const response = await fetch(portalPartnerHealthUrl(base), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 200) return { ok: true, message: "Connected. gx-portal accepted this token." };
    if (response.status === 401) return { ok: false, message: "gx-portal refused this token." };
    if (response.status === 503) return { ok: false, message: "gx-portal has no partner token saved." };
    return { ok: false, message: `gx-portal responded with status ${response.status}.` };
  } catch {
    return { ok: false, message: "gx-portal did not respond." };
  }
}

export async function generatePartnerToken(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await savePartnerToken(token);
  return token;
}

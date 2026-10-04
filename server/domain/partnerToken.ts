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

export async function generatePartnerToken(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await savePartnerToken(token);
  return token;
}

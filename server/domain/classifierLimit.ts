import { readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CLASSIFIER_CASE_LIMIT,
  parseClassifierCaseLimit,
} from "@shared/classifierLimit";

let savedCache: { loaded: boolean; limit: number | null } = {
  loaded: false,
  limit: null,
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** `off` disables the file so tests use the environment or the default. */
export function classifierLimitPath(): string | null {
  const override = process.env.CLASSIFIER_LIMIT_FILE?.trim();
  if (override === "off" || override === "-") return null;
  if (override) return override;
  const root = (process.env.VC_DATA_ROOT || "").trim() || path.join(os.homedir(), "gvi-data");
  return path.join(expandHome(root), "classifier-case-limit");
}

async function readSavedLimit(): Promise<number | null> {
  if (savedCache.loaded) return savedCache.limit;
  const file = classifierLimitPath();
  let limit: number | null = null;
  if (file) {
    try {
      limit = parseClassifierCaseLimit(await readFile(file, "utf8"));
    } catch {
      limit = null;
    }
  }
  savedCache = { loaded: true, limit };
  return limit;
}

export async function resolveClassifierCaseLimit(): Promise<number> {
  return (
    (await readSavedLimit())
    ?? parseClassifierCaseLimit(process.env.CLASSIFIER_CASE_LIMIT)
    ?? DEFAULT_CLASSIFIER_CASE_LIMIT
  );
}

export async function classifierLimitStatus(): Promise<{
  limit: number;
  source: "saved" | "env" | "default";
}> {
  const saved = await readSavedLimit();
  if (saved) return { limit: saved, source: "saved" };
  const env = parseClassifierCaseLimit(process.env.CLASSIFIER_CASE_LIMIT);
  if (env) return { limit: env, source: "env" };
  return { limit: DEFAULT_CLASSIFIER_CASE_LIMIT, source: "default" };
}

export async function saveClassifierCaseLimit(raw: unknown): Promise<void> {
  const file = classifierLimitPath();
  if (!file) throw new Error("Classifier limit storage is disabled");
  const limit = parseClassifierCaseLimit(raw);
  if (!limit) {
    throw new Error(`Enter a whole number from 1 to 5000`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${limit}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    const { rename } = await import("node:fs/promises");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  savedCache = { loaded: true, limit };
}

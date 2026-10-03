import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { ENV } from "../_core/env";

const ROOT = process.cwd();
const PID_DIR = path.join(ROOT, "pids");
const LOG_DIR = path.join(ROOT, "logs");
const COUNT_FILE = path.join(PID_DIR, "classifier-worker-count");
const REGISTRY_FILE = path.join(PID_DIR, "classifier-workers.json");
const LOCK_FILE = path.join(PID_DIR, "classifier-workers.lock");
const LEGACY_PIDFILE = path.join(PID_DIR, "curation-worker.pid");

export const CLASSIFIER_WORKER_MIN = 1;
export const CLASSIFIER_WORKER_MAX = 4;
const HEALTH_PORT_BASE = 8100;

type RegistrySlot = { index: number; pid: number; healthPort: number };

export type ClassifierProcessState = "stopped" | "starting" | "loading" | "ready" | "stopping";

export type ClassifierWorkerProcess = {
  index: number;
  name: string;
  pid: number | null;
  healthPort: number;
  process: ClassifierProcessState;
};

let pythonPath: string | null | undefined;

export function classifierWorkerName(index: number): string {
  return `Worker-${index}`;
}

export function parseClassifierWorkerCount(raw: string | null | undefined): number {
  const text = String(raw ?? "").trim();
  if (!text) return CLASSIFIER_WORKER_MAX;
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) return CLASSIFIER_WORKER_MAX;
  return Math.min(CLASSIFIER_WORKER_MAX, Math.max(CLASSIFIER_WORKER_MIN, parsed));
}

export function readClassifierWorkerCount(): number {
  try {
    return parseClassifierWorkerCount(readFileSync(COUNT_FILE, "utf8"));
  } catch {
    return CLASSIFIER_WORKER_MAX;
  }
}

export function writeClassifierWorkerCount(count: number): number {
  const next = parseClassifierWorkerCount(String(count));
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(COUNT_FILE, `${next}\n`);
  return next;
}

function pythonBin(): string | null {
  if (pythonPath !== undefined) return pythonPath;
  const candidates = [
    "/tmp/gvi-engine-venv/bin/python",
    path.join(ROOT, "engine/.venv/bin/python"),
    "python3",
  ];
  for (const bin of candidates) {
    if (bin !== "python3" && !existsSync(bin)) continue;
    const check = spawnSync(bin, ["-c", "import flask, flask_cors"], { encoding: "utf8" });
    if (check.status === 0) {
      pythonPath = bin;
      return bin;
    }
  }
  pythonPath = null;
  return null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRegistry(): RegistrySlot[] {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as { workers?: RegistrySlot[] };
    if (!Array.isArray(parsed.workers)) return [];
    return parsed.workers.filter(
      slot =>
        Number.isInteger(slot.index) &&
        slot.index >= 0 &&
        slot.index < CLASSIFIER_WORKER_MAX &&
        Number.isInteger(slot.pid) &&
        Number.isInteger(slot.healthPort)
    );
  } catch {
    return [];
  }
}

function writeRegistry(workers: RegistrySlot[]) {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify({ workers }));
}

function withWorkerLock(fn: () => void) {
  mkdirSync(PID_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          // Another ensure already cleared a stale lock.
        }
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - started > 5000) {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          // The holder removed it between the timeout and the unlink.
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
}

function engineWorkerPids(): number[] {
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ");
      if (command.includes("engine.service.worker")) found.push(pid);
    } catch {
      // The process exited while the directory was being scanned.
    }
  }
  return found;
}

function stopPid(pid: number) {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // It exited between the liveness check and the signal.
  }
}

function spawnWorker(index: number, python: string): RegistrySlot {
  const healthPort = HEALTH_PORT_BASE + index;
  const logFile = path.join(LOG_DIR, `curation-worker-${index}.log`);
  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(logFile, "a");
  const child = spawn(python, ["-m", "engine.service.worker"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: ROOT,
      ENGINE_API_URL: process.env.ENGINE_API_URL || `http://127.0.0.1:${process.env.PORT || "3010"}`,
      ENGINE_WORKER_TOKEN: ENV.engineWorkerToken,
      ENGINE_WORKER_ID: classifierWorkerName(index),
      ENGINE_HEALTH_PORT: String(healthPort),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) throw new Error(`Classifier ${classifierWorkerName(index)} did not start.`);
  return { index, pid: child.pid, healthPort };
}

/**
 * Keep the configured number of classifier processes alive.
 * Each process claims one variant. Extra processes are asked to finish the
 * variant they already hold and then exit.
 */
export function ensureClassifierWorkers(): { desired: number; started: number; alive: number } {
  if (ENV.engineWorkerToken.length < 32) {
    throw new Error("ENGINE_WORKER_TOKEN is not configured, so the classifier cannot start.");
  }
  const python = pythonBin();
  if (!python) {
    throw new Error("No Python with flask and flask-cors is available to run the classifier.");
  }
  let desired = readClassifierWorkerCount();
  let started = 0;
  let alive = 0;
  withWorkerLock(() => {
    desired = readClassifierWorkerCount();
    if (!existsSync(COUNT_FILE)) writeClassifierWorkerCount(desired);
    const kept: RegistrySlot[] = [];
    for (const slot of readRegistry()) {
      if (!pidAlive(slot.pid)) continue;
      if (slot.index >= desired) {
        stopPid(slot.pid);
        kept.push(slot);
        continue;
      }
      kept.push(slot);
    }
    const runningIndexes = new Set(kept.filter(slot => slot.index < desired).map(slot => slot.index));
    for (let index = 0; index < desired; index += 1) {
      if (runningIndexes.has(index)) continue;
      kept.push(spawnWorker(index, python));
      started += 1;
    }
    writeRegistry(kept);
    const managed = new Set(kept.map(slot => slot.pid));
    for (const pid of engineWorkerPids()) {
      if (!managed.has(pid)) stopPid(pid);
    }
    if (existsSync(LEGACY_PIDFILE)) {
      try {
        unlinkSync(LEGACY_PIDFILE);
      } catch {
        // The legacy pid file is only a pointer. The process scan above owns shutdown.
      }
    }
    alive = kept.filter(slot => slot.index < desired && pidAlive(slot.pid)).length;
  });
  return { desired, started, alive };
}

/** Starts the configured worker set. `alreadyRunning` means none were spawned. */
export function ensureCurationWorker(): { alreadyRunning: boolean; desired: number; started: number } {
  const result = ensureClassifierWorkers();
  return { alreadyRunning: result.started === 0, desired: result.desired, started: result.started };
}

function probeReady(port: number): Promise<"ready" | "loading" | "down"> {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/readyz`, { timeout: 400 }, res => {
      res.resume();
      resolve(res.statusCode === 200 ? "ready" : "loading");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("down");
    });
    req.on("error", () => resolve("down"));
  });
}

export async function listClassifierWorkerProcesses(): Promise<{
  desired: number;
  workers: ClassifierWorkerProcess[];
}> {
  try {
    ensureClassifierWorkers();
  } catch (error) {
    console.error("[curation] classifier workers:", error instanceof Error ? error.message : error);
  }
  const desired = readClassifierWorkerCount();
  const registry = readRegistry().filter(slot => pidAlive(slot.pid));
  const slots: ClassifierWorkerProcess[] = [];
  for (let index = 0; index < desired; index += 1) {
    const slot = registry.find(item => item.index === index);
    slots.push({
      index,
      name: classifierWorkerName(index),
      pid: slot?.pid ?? null,
      healthPort: slot?.healthPort ?? HEALTH_PORT_BASE + index,
      process: slot ? "starting" : "stopped",
    });
  }
  for (const slot of registry) {
    if (slot.index < desired) continue;
    slots.push({
      index: slot.index,
      name: classifierWorkerName(slot.index),
      pid: slot.pid,
      healthPort: slot.healthPort,
      process: "stopping",
    });
  }
  await Promise.all(
    slots.map(async slot => {
      if (!slot.pid || slot.process === "stopping") return;
      const ready = await probeReady(slot.healthPort);
      if (ready === "ready") slot.process = "ready";
      else if (ready === "loading") slot.process = "loading";
      else slot.process = "starting";
    })
  );
  return { desired, workers: slots.sort((left, right) => left.index - right.index) };
}

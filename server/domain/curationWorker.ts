import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV } from "../_core/env";

const ROOT = process.cwd();
const PIDFILE = path.join(ROOT, "pids", "curation-worker.pid");
const LOGFILE = path.join(ROOT, "logs", "curation-worker.log");

function pythonBin(): string | null {
  const candidates = [
    "/tmp/gvi-engine-venv/bin/python",
    path.join(ROOT, "engine/.venv/bin/python"),
    "python3",
  ];
  for (const bin of candidates) {
    if (bin !== "python3" && !existsSync(bin)) continue;
    const check = spawnSync(bin, ["-c", "import flask, flask_cors"], { encoding: "utf8" });
    if (check.status === 0) return bin;
  }
  return null;
}

function workerAlive(): boolean {
  if (!existsSync(PIDFILE)) return false;
  const pid = Number(readFileSync(PIDFILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the SAM-VC classifier worker if it is not already polling.
 * One process claims one released run at a time, so a batch shows a single
 * Running row while the rest stay Queued.
 */
export function ensureCurationWorker(): { alreadyRunning: boolean } {
  if (ENV.engineWorkerToken.length < 32) {
    throw new Error("ENGINE_WORKER_TOKEN is not configured, so the classifier cannot start.");
  }
  if (workerAlive()) return { alreadyRunning: true };
  const python = pythonBin();
  if (!python) {
    throw new Error("No Python with flask and flask-cors is available to run the classifier.");
  }
  mkdirSync(path.dirname(PIDFILE), { recursive: true });
  mkdirSync(path.dirname(LOGFILE), { recursive: true });
  const logFd = openSync(LOGFILE, "a");
  const child = spawn(python, ["-m", "engine.service.worker"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: ROOT,
      ENGINE_API_URL: process.env.ENGINE_API_URL || `http://127.0.0.1:${process.env.PORT || "3010"}`,
      ENGINE_WORKER_TOKEN: ENV.engineWorkerToken,
      ENGINE_HEALTH_PORT: process.env.ENGINE_HEALTH_PORT || "8095",
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error("The classifier process did not start.");
  writeFileSync(PIDFILE, String(child.pid));
  return { alreadyRunning: false };
}

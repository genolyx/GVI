import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `server/_core/env.ts` snapshots `process.env` at import time, so each scenario
 * resets the module registry and re-imports the router with the token it wants.
 * Mutating `process.env` around an already-imported router would test nothing.
 */
async function bootEngineApi(workerToken: string | undefined) {
  const previous = process.env.ENGINE_WORKER_TOKEN;
  if (workerToken === undefined) delete process.env.ENGINE_WORKER_TOKEN;
  else process.env.ENGINE_WORKER_TOKEN = workerToken;

  vi.resetModules();
  let app: Express;
  let server: Server;
  try {
    const { registerEngineApiRoutes } = await import("./engineApi");
    app = express();
    app.use(express.json());
    registerEngineApiRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    if (previous === undefined) delete process.env.ENGINE_WORKER_TOKEN;
    else process.env.ENGINE_WORKER_TOKEN = previous;
  }

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind test server");

  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close(error => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("Engine API v1 worker credential", () => {
  const testToken = "gvi-local-engine-worker-token-0123456789";

  it("accepts the configured worker credential", async () => {
    const { baseUrl } = await bootEngineApi(testToken);
    const response = await fetch(`${baseUrl}/api/engine/v1/health`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "gvi-engine-api",
      version: "v1",
      authenticated: true,
      llm: false,
    });
  });

  it("rejects an invalid credential", async () => {
    const { baseUrl } = await bootEngineApi(testToken);
    const response = await fetch(`${baseUrl}/api/engine/v1/health`, {
      headers: { Authorization: "Bearer not-the-worker-token-but-long-enough" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a request with no credential", async () => {
    const { baseUrl } = await bootEngineApi(testToken);
    const response = await fetch(`${baseUrl}/api/engine/v1/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "worker-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("fails closed when no worker credential is configured", async () => {
    const { baseUrl } = await bootEngineApi(undefined);
    const response = await fetch(`${baseUrl}/api/engine/v1/health`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "engine_api_not_configured" });
  });

  it("refuses an LLM completion when the control-plane model is not configured", async () => {
    const { baseUrl } = await bootEngineApi(testToken);
    const response = await fetch(`${baseUrl}/api/engine/v1/llm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ purpose: "gene_profile", prompt: "Summarize AMT." }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "llm_not_configured" });
  });

  it("fails closed when the configured credential is too short to be a secret", async () => {
    const { baseUrl } = await bootEngineApi("short");
    const response = await fetch(`${baseUrl}/api/engine/v1/health`, {
      headers: { Authorization: "Bearer short" },
    });
    expect(response.status).toBe(503);
  });
});

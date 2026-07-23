import express from "express";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerGatewayAuthRoutes } from "./gatewayAuth";

describe("GVI gateway credential", () => {
  const app = express();
  const server = createServer(app);
  const testToken = "gvi-local-test-token-0123456789abcdef";
  let baseUrl = "";
  let originalToken: string | undefined;

  beforeAll(async () => {
    originalToken = process.env.GVI_GATEWAY_TOKEN;
    process.env.GVI_GATEWAY_TOKEN = testToken;
    registerGatewayAuthRoutes(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to bind test server");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
    if (originalToken === undefined) delete process.env.GVI_GATEWAY_TOKEN;
    else process.env.GVI_GATEWAY_TOKEN = originalToken;
  });

  it("accepts the configured machine credential at the health endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/gateway/health`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "gvi-gateway",
      authenticated: true,
    });
  });

  it("rejects an invalid credential", async () => {
    const response = await fetch(`${baseUrl}/api/gateway/health`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(response.status).toBe(401);
  });

  it("fails closed when no machine credential is configured", async () => {
    delete process.env.GVI_GATEWAY_TOKEN;
    try {
      const response = await fetch(`${baseUrl}/api/gateway/health`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "gateway_not_configured" });
    } finally {
      process.env.GVI_GATEWAY_TOKEN = testToken;
    }
  });
});

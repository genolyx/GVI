import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("partner token", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gvi-partner-"));
    process.env.PARTNER_TOKEN_FILE = path.join(dir, "token");
    delete process.env.PARTNER_API_TOKEN;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.PARTNER_TOKEN_FILE;
    delete process.env.PARTNER_API_TOKEN;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("generates a token the partner API can accept", async () => {
    const mod = await import("./partnerToken");
    const token = await mod.generatePartnerToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    await expect(mod.resolvePartnerToken()).resolves.toBe(token);
    await expect(mod.partnerTokenStatus()).resolves.toMatchObject({
      configured: true,
      source: "saved",
      preview: `…${token.slice(-4)}`,
    });
  });

  it("prefers a pasted token and falls back to the environment when cleared", async () => {
    process.env.PARTNER_API_TOKEN = "env-partner-token-0123456789abcdef";
    vi.resetModules();
    const mod = await import("./partnerToken");
    await expect(mod.resolvePartnerToken()).resolves.toBe(
      "env-partner-token-0123456789abcdef",
    );
    await mod.savePartnerToken("pasted-partner-token-0123456789abcd");
    await expect(mod.resolvePartnerToken()).resolves.toBe(
      "pasted-partner-token-0123456789abcd",
    );
    await mod.savePartnerToken("");
    await expect(mod.resolvePartnerToken()).resolves.toBe(
      "env-partner-token-0123456789abcdef",
    );
    await expect(mod.partnerTokenStatus()).resolves.toMatchObject({ source: "env" });
  });

  it("rejects a short token", async () => {
    const mod = await import("./partnerToken");
    await expect(mod.savePartnerToken("too-short")).rejects.toThrow(/32/);
  });
});

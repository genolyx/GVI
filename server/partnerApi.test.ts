import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARTNER_INTERPRETATION_JOBS_PATH } from "@shared/partnerInterpretation";

const createPartnerInterpretationJob = vi.fn();
const getPartnerInterpretationJob = vi.fn();
const getPartnerVariantDocument = vi.fn();
const listPartnerVariants = vi.fn();
const uploadPartnerVcf = vi.fn();

vi.mock("./domain/partnerJobs", () => ({
  createPartnerInterpretationJob: (...args: unknown[]) =>
    createPartnerInterpretationJob(...args),
  getPartnerInterpretationJob: (...args: unknown[]) =>
    getPartnerInterpretationJob(...args),
  getPartnerVariantDocument: (...args: unknown[]) =>
    getPartnerVariantDocument(...args),
  listPartnerVariants: (...args: unknown[]) => listPartnerVariants(...args),
  uploadPartnerVcf: (...args: unknown[]) => uploadPartnerVcf(...args),
  partnerErrorStatus: (error: unknown) => {
    if (error instanceof Error && "status" in error && "code" in error) {
      const partner = error as Error & { status: number; code: string };
      return {
        status: partner.status,
        body: { error: partner.code, message: partner.message },
      };
    }
    return { status: 500, body: { error: "partner_job_failed" } };
  },
}));

const servers: Server[] = [];
const token = "gvi-local-partner-api-token-0123456789";

async function boot() {
  vi.resetModules();
  const { registerPartnerRoutes } = await import("./partnerApi");
  const app: Express = express();
  app.use(express.json());
  registerPartnerRoutes(app);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to bind test server");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  process.env.PARTNER_API_TOKEN = token;
  createPartnerInterpretationJob.mockReset();
  getPartnerInterpretationJob.mockReset();
  getPartnerVariantDocument.mockReset();
  listPartnerVariants.mockReset();
  uploadPartnerVcf.mockReset();
});

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

describe("partner interpretation API", () => {
  it("requires its own bearer token", async () => {
    const baseUrl = await boot();
    const missing = await fetch(`${baseUrl}/api/partner/v1/health`);
    expect(missing.status).toBe(401);
    const ok = await fetch(`${baseUrl}/api/partner/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      service: "gvi-partner-api",
      authenticated: true,
    });
  });

  it("stays closed when the token is not configured", async () => {
    delete process.env.PARTNER_API_TOKEN;
    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/api/partner/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
  });

  it("declines an out-of-scope service before creating a case", async () => {
    const baseUrl = await boot();
    const response = await fetch(
      `${baseUrl}${PARTNER_INTERPRETATION_JOBS_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody({ serviceCode: "sgnipt" })),
      }
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      reason: "sgnipt_out_of_scope",
    });
    expect(createPartnerInterpretationJob).not.toHaveBeenCalled();
  });

  it("accepts a carrier job and returns the stored view", async () => {
    createPartnerInterpretationJob.mockResolvedValue({
      id: "b".repeat(64),
      status: "queued",
      track: "carrier",
    });
    const baseUrl = await boot();
    const response = await fetch(
      `${baseUrl}${PARTNER_INTERPRETATION_JOBS_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody()),
      }
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      track: "carrier",
    });
    expect(createPartnerInterpretationJob).toHaveBeenCalledOnce();
    const decision = createPartnerInterpretationJob.mock.calls[0]?.[0];
    expect(decision.accepted).toBe(true);
    expect(decision.track).toBe("carrier");
  });

  it("reads a curation document for one variant", async () => {
    getPartnerVariantDocument.mockResolvedValue({
      runId: 9,
      variantKey: "GRCh38:1:100:A:T",
      documentHash: "c".repeat(64),
      document: { contractVersion: "1.0" },
    });
    const baseUrl = await boot();
    const response = await fetch(
      `${baseUrl}${PARTNER_INTERPRETATION_JOBS_PATH}/${"d".repeat(64)}/variants/${encodeURIComponent("GRCh38:1:100:A:T")}/document`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(response.status).toBe(200);
    expect(getPartnerVariantDocument).toHaveBeenCalledWith(
      "d".repeat(64),
      "GRCh38:1:100:A:T"
    );
  });
});

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1",
    externalOrderId: "CSGX26070001",
    serviceCode: "carrier_screening",
    referenceBuild: "GRCh38",
    vcf: {
      sha256: "a".repeat(64),
      uri: "file:///orders/CSGX26070001/annotated.vcf.gz",
    },
    genes: "CFTR",
    ...overrides,
  };
}

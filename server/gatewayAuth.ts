import type { Express, NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { analysisEvents, analysisJobs, cases } from "../drizzle/schema";
import { writeAuditEvent } from "./domain/audit";
import { requireDb } from "./domain/tenant";

/** Case statuses the gateway may advance; never overwrite a reported case. */
const GATEWAY_UPDATABLE_CASE_STATUSES = ["queued", "running", "review_ready", "failed"] as const;

function tokensMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function requireGatewayAuth(req: Request, res: Response, next: NextFunction) {
  const configuredToken = process.env.GVI_GATEWAY_TOKEN;
  const authorization = req.header("authorization") || "";
  const receivedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!configuredToken || configuredToken.length < 32) {
    res.status(503).json({ error: "gateway_not_configured" });
    return;
  }
  if (!receivedToken || !tokensMatch(receivedToken, configuredToken)) {
    res.status(401).json({ error: "invalid_gateway_credential" });
    return;
  }
  next();
}

export function registerGatewayAuthRoutes(app: Express) {
  app.get("/api/gateway/health", requireGatewayAuth, (_req, res) => {
    res.json({ service: "gvi-gateway", authenticated: true });
  });

  app.post("/api/gateway/jobs/claim", requireGatewayAuth, (_req, res) => {
    // FASTQ/BAM sequencing and IGV alignment stay outside this application.
    // VCF interpretation is ingested here and is not dispatched to a gateway.
    res.status(204).end();
  });

  app.post("/api/gateway/jobs/:jobId/events", requireGatewayAuth, async (req, res) => {
    try {
      const params = z.object({ jobId: z.coerce.number().int().positive() }).parse(req.params);
      const input = z
        .object({
          organizationId: z.number().int().positive(),
          externalJobId: z.string().trim().min(6).max(160),
          status: z.enum(["running", "review_ready", "failed", "completed"]),
          progressPercent: z.number().int().min(0).max(100),
          message: z.string().trim().min(1).max(2000),
          metadata: z.record(z.string(), z.unknown()).optional(),
          errorMessage: z.string().trim().max(4000).optional(),
        })
        .parse(req.body);
      const db = await requireDb();
      const rows = await db
        .select()
        .from(analysisJobs)
        .where(
          and(
            eq(analysisJobs.id, params.jobId),
            eq(analysisJobs.organizationId, input.organizationId),
            eq(analysisJobs.externalJobId, input.externalJobId)
          )
        )
        .limit(1);
      const job = rows[0];
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      const completedAt = ["review_ready", "failed", "completed"].includes(input.status)
        ? new Date()
        : null;
      await db.transaction(async tx => {
        await tx
          .update(analysisJobs)
          .set({
            status: input.status,
            progressPercent: input.progressPercent,
            errorMessage: input.errorMessage || null,
            completedAt,
          })
          .where(
            and(
              eq(analysisJobs.id, job.id),
              eq(analysisJobs.organizationId, job.organizationId),
              eq(analysisJobs.externalJobId, input.externalJobId)
            )
          );
        await tx.insert(analysisEvents).values({
          organizationId: job.organizationId,
          jobId: job.id,
          status: input.status,
          message: input.message,
          progressPercent: input.progressPercent,
          metadata: input.metadata || null,
        });
        const caseStatus = input.status === "review_ready" || input.status === "completed"
          ? "review_ready"
          : input.status === "failed" ? "failed" : "running";
        await tx
          .update(cases)
          .set({ status: caseStatus })
          .where(
            and(
              eq(cases.id, job.caseId),
              eq(cases.organizationId, job.organizationId),
              inArray(cases.status, [...GATEWAY_UPDATABLE_CASE_STATUSES])
            )
          );
      });
      await writeAuditEvent({
        organizationId: job.organizationId,
        actorUserId: null,
        action: "gateway.job_status_changed",
        entityType: "analysis_job",
        entityId: job.id,
        before: { status: job.status, progressPercent: job.progressPercent },
        after: { status: input.status, progressPercent: input.progressPercent },
        req,
      });
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gateway event failed";
      res.status(400).json({ error: "invalid_event_request", message });
    }
  });
}

import type { Express, NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { curationRunEvents, curationRuns } from "../drizzle/schema";
import { buildCurationSummary, curationDocumentSchema } from "../shared/curation/document";
import { ENV } from "./_core/env";
import { writeAuditEvent } from "./domain/audit";
import { mergeCurationDocument } from "./domain/curationMerge";
import {
  ENGINE_LLM_PURPOSES,
  invokeEngineLlm,
  isEngineLlmConfigured,
} from "./domain/engineLlm";
import {
  claimCurationRun,
  curationStoragePrefix,
  extendCurationLease,
  getLeasedRun,
  reapExpiredCurationLeases,
} from "./domain/curationQueue";
import { requireDb } from "./domain/tenant";
import { storageCreateUploadUrl } from "./storage";

/**
 * Engine API v1 — the only surface curation workers talk to.
 *
 * Workers hold no database credentials. Tenant isolation lives in
 * `server/domain/tenant.ts` and the composite foreign keys, and keeping workers on
 * HTTP means that logic never has to be reimplemented in Python.
 *
 * Authentication is a shared bearer token rather than per-worker credentials: every
 * worker is equally trusted and the control plane decides which run each one gets,
 * so a worker identity would add rotation burden without adding authority.
 */

const RUN_ID_PARAMS = z.object({ runId: z.coerce.number().int().positive() });
const WORKER_ID = z.string().trim().min(3).max(120);

function tokensMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function requireEngineWorkerAuth(req: Request, res: Response, next: NextFunction) {
  const configured = ENV.engineWorkerToken;
  const authorization = req.header("authorization") || "";
  const received = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!configured || configured.length < 32) {
    res.status(503).json({ error: "engine_api_not_configured" });
    return;
  }
  if (!received || !tokensMatch(received, configured)) {
    res.status(401).json({ error: "invalid_worker_credential" });
    return;
  }
  next();
}

export function registerEngineApiRoutes(app: Express) {
  app.get("/api/engine/v1/health", requireEngineWorkerAuth, (_req, res) => {
    res.json({
      service: "gvi-engine-api",
      version: "v1",
      authenticated: true,
      llm: isEngineLlmConfigured(),
    });
  });

  /**
   * LLM completions for the engine (gene profile, literature summaries).
   *
   * Workers hold no model keys. The control plane applies the same "do not
   * classify" guardrail as Copilot and writes an audit row per call so a
   * narrative that later appears in a report has a provenance trail.
   */
  app.post("/api/engine/v1/llm", requireEngineWorkerAuth, async (req, res) => {
    if (!isEngineLlmConfigured()) {
      res.status(503).json({ error: "llm_not_configured" });
      return;
    }
    try {
      const input = z
        .object({
          purpose: z.enum(ENGINE_LLM_PURPOSES),
          prompt: z.string().trim().min(1).max(200_000),
          runId: z.number().int().positive().optional(),
          workerId: WORKER_ID.optional(),
        })
        .parse(req.body);

      const text = await invokeEngineLlm(input.purpose, input.prompt);
      if (input.runId) {
        try {
          const db = await requireDb();
          const run = await db
            .select({ organizationId: curationRuns.organizationId })
            .from(curationRuns)
            .where(eq(curationRuns.id, input.runId))
            .limit(1);
          if (run[0]) {
            await writeAuditEvent({
              organizationId: run[0].organizationId,
              actorUserId: null,
              action: "curation.llm",
              entityType: "curation_run",
              entityId: input.runId,
              after: { purpose: input.purpose, promptChars: input.prompt.length, replyChars: text.length },
              req,
            });
          }
        } catch (error) {
          console.warn("[EngineAPI] LLM audit failed:", error);
        }
      }
      res.json({ text });
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM request rejected";
      res.status(400).json({ error: "invalid_llm_request", message });
    }
  });

  /**
   * Lease the next queued run and hand back everything the worker needs: the engine
   * input, and presigned PUT URLs for the document and the raw engine response. The
   * worker never learns a storage credential.
   */
  app.post("/api/engine/v1/claim", requireEngineWorkerAuth, async (req, res) => {
    try {
      const workerId = WORKER_ID.parse(req.body?.workerId);
      const run = await claimCurationRun(workerId);
      if (!run) {
        res.status(204).end();
        return;
      }

      const prefix = curationStoragePrefix(run.organizationId, run.id);
      const [documentUpload, rawUpload] = await Promise.all([
        storageCreateUploadUrl(`${prefix}/attempt-${run.attempt}/document.v1.json`),
        storageCreateUploadUrl(`${prefix}/attempt-${run.attempt}/engine-raw.json`),
      ]);

      const db = await requireDb();
      await db.insert(curationRunEvents).values({
        organizationId: run.organizationId,
        runId: run.id,
        status: "running",
        message: `Claimed by worker ${workerId} (attempt ${run.attempt}).`,
        progressPercent: 1,
        metadata: { workerId, attempt: run.attempt },
      });

      res.json({
        runId: run.id,
        organizationId: run.organizationId,
        attempt: run.attempt,
        contractVersion: "1.0",
        leaseExpiresAt: run.leaseExpiresAt,
        input: run.input,
        documentUpload: {
          key: documentUpload.key,
          url: documentUpload.uploadUrl,
          headers: { "Content-Type": "application/json" },
        },
        rawUpload: {
          key: rawUpload.key,
          url: rawUpload.uploadUrl,
          headers: { "Content-Type": "application/json" },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claim failed";
      res.status(400).json({ error: "invalid_claim_request", message });
    }
  });

  app.post("/api/engine/v1/runs/:runId/heartbeat", requireEngineWorkerAuth, async (req, res) => {
    try {
      const { runId } = RUN_ID_PARAMS.parse(req.params);
      const workerId = WORKER_ID.parse(req.body?.workerId);
      const leaseExpiresAt = await extendCurationLease(runId, workerId);
      if (!leaseExpiresAt) {
        // The reaper already took the run back; the worker should abandon it.
        res.status(409).json({ error: "lease_lost" });
        return;
      }
      res.json({ leaseExpiresAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Heartbeat failed";
      res.status(400).json({ error: "invalid_heartbeat_request", message });
    }
  });

  app.post("/api/engine/v1/runs/:runId/events", requireEngineWorkerAuth, async (req, res) => {
    try {
      const { runId } = RUN_ID_PARAMS.parse(req.params);
      const input = z
        .object({
          workerId: WORKER_ID,
          status: z.string().trim().min(1).max(40),
          message: z.string().trim().min(1).max(2000),
          progressPercent: z.number().int().min(0).max(100),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);

      const run = await getLeasedRun(runId, input.workerId);
      if (!run) {
        res.status(409).json({ error: "lease_lost" });
        return;
      }

      const db = await requireDb();
      await db.insert(curationRunEvents).values({
        organizationId: run.organizationId,
        runId: run.id,
        status: input.status,
        message: input.message,
        progressPercent: input.progressPercent,
        metadata: input.metadata || null,
      });
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Event failed";
      res.status(400).json({ error: "invalid_event_request", message });
    }
  });

  /**
   * Accept a finished run.
   *
   * The document is validated against the contract here rather than trusted: it came
   * from a separate codebase and embeds strings fetched from external sources. The
   * queryable `summary` is derived server-side so that projection exists in exactly
   * one place.
   */
  app.post("/api/engine/v1/runs/:runId/complete", requireEngineWorkerAuth, async (req, res) => {
    try {
      const { runId } = RUN_ID_PARAMS.parse(req.params);
      const envelope = z
        .object({
          workerId: WORKER_ID,
          document: z.unknown(),
          documentKey: z.string().trim().min(1).max(512),
          documentHash: z.string().trim().regex(/^[0-9a-f]{64}$/),
          rawKey: z.string().trim().min(1).max(512),
          rawHash: z.string().trim().regex(/^[0-9a-f]{64}$/),
          timings: z.record(z.string(), z.number()).optional(),
        })
        .parse(req.body);

      const run = await getLeasedRun(runId, envelope.workerId);
      if (!run) {
        res.status(409).json({ error: "lease_lost" });
        return;
      }

      const parsed = curationDocumentSchema.safeParse(envelope.document);
      if (!parsed.success) {
        res.status(422).json({
          error: "contract_violation",
          issues: parsed.error.issues.slice(0, 20),
        });
        return;
      }
      const document = parsed.data;

      const db = await requireDb();
      await db.transaction(async tx => {
        await tx
          .update(curationRuns)
          .set({
            status: "succeeded",
            documentKey: envelope.documentKey,
            documentHash: envelope.documentHash,
            rawKey: envelope.rawKey,
            rawHash: envelope.rawHash,
            summary: buildCurationSummary(document),
            engineVersion: document.meta.engineVersion,
            contractVersion: document.contractVersion,
            timings: envelope.timings ?? null,
            error: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          })
          .where(and(eq(curationRuns.id, run.id), eq(curationRuns.organizationId, run.organizationId)));

        await tx.insert(curationRunEvents).values({
          organizationId: run.organizationId,
          runId: run.id,
          status: "succeeded",
          message: document.acmg.classification
            ? `Engine suggests ${document.acmg.classification.label} from ${document.acmg.criteria.length} criteria.`
            : "Engine completed without a classification.",
          progressPercent: 100,
          metadata: { documentHash: envelope.documentHash },
        });
      });

      /**
       * Fold the engine's criteria into a draft interpretation.
       *
       * Done outside the run-status transaction on purpose: a merge failure must not
       * roll back a run the worker already completed and uploaded, because the
       * document is durable and the merge can be retried from it. The run is
       * reported as succeeded either way, with the merge outcome recorded as an
       * event so the gap is visible.
       */
      let merge: Awaited<ReturnType<typeof mergeCurationDocument>> = null;
      let mergeError: string | null = null;
      try {
        merge = await mergeCurationDocument(run, document);
      } catch (error) {
        mergeError = error instanceof Error ? error.message : "Merge failed";
        console.error(`[EngineAPI] Merge failed for run ${run.id}:`, error);
      }

      if (merge || mergeError) {
        const db2 = await requireDb();
        await db2.insert(curationRunEvents).values({
          organizationId: run.organizationId,
          runId: run.id,
          status: mergeError ? "merge_failed" : "merged",
          message: mergeError
            ? `Engine criteria could not be merged: ${mergeError}`
            : `Merged ${merge!.criteriaWritten} criteria and ${merge!.evidenceWritten} evidence items into interpretation ${merge!.interpretationId}.`,
          progressPercent: 100,
          metadata: mergeError ? { error: mergeError } : { ...merge },
        });
      }

      await writeAuditEvent({
        organizationId: run.organizationId,
        actorUserId: null,
        action: "curation.run_succeeded",
        entityType: "curation_run",
        entityId: run.id,
        after: {
          variantId: run.variantId,
          documentHash: envelope.documentHash,
          engineVersion: document.meta.engineVersion,
          classification: document.acmg.classification?.label ?? null,
          sourcesDisabled: document.meta.sourcesDisabled,
          interpretationId: merge?.interpretationId ?? null,
          criteriaMerged: merge?.criteriaWritten ?? 0,
          mergeError,
        },
        req,
      });

      res.json({ success: true, merge, mergeError });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Complete failed";
      res.status(400).json({ error: "invalid_complete_request", message });
    }
  });

  app.post("/api/engine/v1/runs/:runId/fail", requireEngineWorkerAuth, async (req, res) => {
    try {
      const { runId } = RUN_ID_PARAMS.parse(req.params);
      const input = z
        .object({
          workerId: WORKER_ID,
          error: z.object({
            message: z.string().trim().min(1).max(2000),
            kind: z.string().trim().min(1).max(60),
          }),
          retryable: z.boolean(),
        })
        .parse(req.body);

      const run = await getLeasedRun(runId, input.workerId);
      if (!run) {
        res.status(409).json({ error: "lease_lost" });
        return;
      }

      // A retryable failure goes back in the queue only while attempts remain.
      const requeue = input.retryable && run.attempt < run.maxAttempts;
      const db = await requireDb();
      await db.transaction(async tx => {
        await tx
          .update(curationRuns)
          .set({
            status: requeue ? "queued" : "failed",
            workerId: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            queuedAt: requeue ? new Date() : run.queuedAt,
            completedAt: requeue ? null : new Date(),
            error: {
              kind: input.error.kind,
              message: input.error.message,
              attempt: run.attempt,
              at: new Date().toISOString(),
            },
          })
          .where(and(eq(curationRuns.id, run.id), eq(curationRuns.organizationId, run.organizationId)));

        await tx.insert(curationRunEvents).values({
          organizationId: run.organizationId,
          runId: run.id,
          status: requeue ? "queued" : "failed",
          message: requeue
            ? `Attempt ${run.attempt} failed (${input.error.kind}); requeued.`
            : `Failed (${input.error.kind}): ${input.error.message}`,
          progressPercent: 0,
        });
      });

      res.json({ success: true, requeued: requeue });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fail report rejected";
      res.status(400).json({ error: "invalid_fail_request", message });
    }
  });
}

/**
 * Sweep expired leases on an interval.
 *
 * Runs on every app instance. That is safe because each statement is a single
 * atomic `UPDATE … WHERE status='running' AND leaseExpiresAt < now()`, so a
 * concurrent sweep finds nothing left to do rather than double-requeueing.
 */
export function startCurationReaper(): NodeJS.Timeout {
  const intervalMs = Math.max(30_000, (ENV.engineLeaseSeconds * 1000) / 4);

  const sweep = async () => {
    try {
      const { requeued, exhausted } = await reapExpiredCurationLeases();
      if (requeued.length || exhausted.length) {
        console.log(
          `[CurationReaper] requeued ${requeued.length}, failed ${exhausted.length} expired lease(s)`
        );
      }
    } catch (error) {
      console.warn("[CurationReaper] sweep failed:", error);
    }
  };

  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return timer;
}

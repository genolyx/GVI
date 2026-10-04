import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import {
  interpretPartnerJob,
  PARTNER_INTERPRETATION_JOBS_PATH,
} from "@shared/partnerInterpretation";
import {
  applyPartnerPanel,
  cancelPartnerClassification,
  createPartnerInterpretationJob,
  getPartnerDarkGenes,
  getPartnerInterpretationJob,
  getPartnerJobByExternalOrder,
  listPartnerJobProgress,
  getPartnerVariantDocument,
  listPartnerVariants,
  partnerErrorStatus,
  submitPartnerDarkGenes,
  uploadPartnerVcf,
} from "./domain/partnerJobs";
import { resolvePartnerToken } from "./domain/partnerToken";

function tokensMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export async function requirePartnerAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const configuredToken = await resolvePartnerToken();
    const authorization = req.header("authorization") || "";
    const receivedToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!configuredToken) {
      res.status(503).json({ error: "partner_not_configured" });
      return;
    }
    if (!receivedToken || !tokensMatch(receivedToken, configuredToken)) {
      res.status(401).json({ error: "invalid_partner_credential" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

function sendFailure(res: Response, error: unknown) {
  const failure = partnerErrorStatus(error);
  res.status(failure.status).json(failure.body);
}

export function registerPartnerRoutes(app: Express) {
  app.get("/api/partner/v1/health", requirePartnerAuth, (_req, res) => {
    res.json({
      service: "gvi-partner-api",
      version: "v1",
      authenticated: true,
    });
  });

  app.post(
    PARTNER_INTERPRETATION_JOBS_PATH,
    requirePartnerAuth,
    async (req, res) => {
      const prepared = await applyPartnerPanel(req.body);
      if (!prepared.ok) {
        res.status(422).json({ accepted: false, reason: "invalid_request", message: prepared.message });
        return;
      }
      const decision = interpretPartnerJob(prepared.body);
      if (!decision.accepted) {
        res.status(422).json({
          accepted: false,
          reason: decision.reason,
          ...(decision.message ? { message: decision.message } : {}),
        });
        return;
      }
      try {
        const job = await createPartnerInterpretationJob(decision);
        res.status(202).json(job);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.get(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/variants/:variantKey/document`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const document = await getPartnerVariantDocument(
          req.params.id,
          req.params.variantKey
        );
        res.json(document);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.get(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/variants`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const variants = await listPartnerVariants(req.params.id);
        res.json({ variants });
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.put(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/dark-genes`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const darkGenes = await submitPartnerDarkGenes(req.params.id, req.body);
        res.status(200).json(darkGenes);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.get(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/dark-genes`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const darkGenes = await getPartnerDarkGenes(req.params.id);
        res.json(darkGenes);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.put(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/vcf`,
    requirePartnerAuth,
    express.raw({ type: () => true, limit: "200mb" }),
    async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const job = await uploadPartnerVcf(req.params.id, body);
        res.status(202).json(job);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.post(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/progress`,
    requirePartnerAuth,
    async (req, res) => {
      const ids = Array.isArray(req.body?.externalOrderIds)
        ? req.body.externalOrderIds.filter((id: unknown) => typeof id === "string")
        : [];
      try {
        const jobs = await listPartnerJobProgress(ids);
        res.json({ jobs });
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.post(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id/cancel`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const result = await cancelPartnerClassification(req.params.id);
        res.json(result);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.get(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/by-order/:externalOrderId`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const job = await getPartnerJobByExternalOrder(req.params.externalOrderId);
        if (!job) {
          res.status(404).json({ error: "job_not_found" });
          return;
        }
        res.json(job);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );

  app.get(
    `${PARTNER_INTERPRETATION_JOBS_PATH}/:id`,
    requirePartnerAuth,
    async (req, res) => {
      try {
        const job = await getPartnerInterpretationJob(req.params.id);
        res.json(job);
      } catch (error) {
        sendFailure(res, error);
      }
    }
  );
}

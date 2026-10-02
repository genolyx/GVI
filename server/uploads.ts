import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { cases } from "../drizzle/schema";
import { HttpError } from "../shared/_core/errors";
import { sdk } from "./_core/sdk";
import { requireDb, requireOrganizationPermission } from "./domain/tenant";
import { storageWriteStream } from "./storage";

const uploadKey =
  /^organizations\/(\d+)\/cases\/(\d+)\/files\/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,180}$/;

function uploadKeyFromRequest(req: Request): string | null {
  const raw = req.params[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function registerUploadRoute(app: Express) {
  app.put("/api/uploads/*", async (req: Request, res: Response) => {
    const key = uploadKeyFromRequest(req);
    const match = key ? uploadKey.exec(key) : null;
    if (!match) {
      res.status(400).json({ error: "invalid_upload_path" });
      return;
    }
    const contentLength = Number(req.headers["content-length"]);
    if (!Number.isInteger(contentLength) || contentLength <= 0) {
      res.status(411).json({ error: "content_length_required" });
      return;
    }

    const organizationId = Number(match[1]);
    const caseId = Number(match[2]);
    try {
      const user = await sdk.authenticateRequest(req);
      await requireOrganizationPermission(user.id, organizationId, "file:upload");
      const db = await requireDb();
      const [clinicalCase] = await db
        .select({ status: cases.status })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
        .limit(1);
      if (!clinicalCase) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }
      if (clinicalCase.status !== "draft") {
        res.status(409).json({ error: "case_is_not_a_draft" });
        return;
      }
      const contentType =
        typeof req.headers["content-type"] === "string"
          ? req.headers["content-type"]
          : "application/octet-stream";
      await storageWriteStream(key!, req, contentLength, contentType);
      res.status(204).end();
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (error instanceof TRPCError) {
        const status = error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 400;
        res.status(status).json({ error: error.message });
        return;
      }
      console.error("[Upload] storage write failed:", error instanceof Error ? error.message : error);
      res.status(502).json({ error: "storage_write_failed" });
    }
  });
}

import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { auditEvents } from "../../drizzle/schema";
import { requireDb } from "./tenant";

type AuditPayload = {
  organizationId: number;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: string | number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  req?: Request;
};

export async function writeAuditEvent(payload: AuditPayload) {
  const db = await requireDb();
  const forwarded = payload.req?.headers["x-forwarded-for"];
  const ipAddress = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(",")[0]?.trim() || payload.req?.ip || null;

  await db.insert(auditEvents).values({
    organizationId: payload.organizationId,
    actorUserId: payload.actorUserId,
    action: payload.action,
    entityType: payload.entityType,
    entityId: String(payload.entityId),
    requestId: payload.req?.headers["x-request-id"]?.toString() || randomUUID(),
    before: payload.before ?? null,
    after: payload.after ?? null,
    ipAddress,
    userAgent: payload.req?.headers["user-agent"]?.slice(0, 512) || null,
  });
}

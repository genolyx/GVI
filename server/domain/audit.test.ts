import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ inserted: null as Record<string, unknown> | null }));
vi.mock("./tenant", () => ({
  requireDb: vi.fn(async () => ({
    insert: () => ({ values: async (value: Record<string, unknown>) => { state.inserted = value; } }),
  })),
}));

import { writeAuditEvent } from "./audit";

describe("append-only audit metadata", () => {
  beforeEach(() => { state.inserted = null; });

  it("records organization, actor, target, before/after and normalized request metadata", async () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1", "x-request-id": "req-clinical-1", "user-agent": "Vitest clinical client" }, ip: "127.0.0.1" } as unknown as Request;
    await writeAuditEvent({ organizationId: 71, actorUserId: 33, action: "interpretation.approved", entityType: "interpretation", entityId: 88, before: { status: "draft" }, after: { status: "approved" }, req });
    expect(state.inserted).toMatchObject({ organizationId: 71, actorUserId: 33, action: "interpretation.approved", entityType: "interpretation", entityId: "88", requestId: "req-clinical-1", ipAddress: "203.0.113.10", before: { status: "draft" }, after: { status: "approved" } });
  });

  it("generates a request ID for non-HTTP audit producers", async () => {
    await writeAuditEvent({ organizationId: 71, actorUserId: null, action: "analysis.completed", entityType: "analysis_job", entityId: 9 });
    expect(state.inserted?.requestId).toEqual(expect.any(String));
  });
});

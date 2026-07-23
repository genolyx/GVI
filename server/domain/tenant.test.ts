import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("../db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => state.rows }),
        }),
      }),
    }),
  })),
}));

import { requireOrganizationPermission } from "./tenant";

describe("tenant and RBAC boundary", () => {
  beforeEach(() => { state.rows = []; });

  it("conceals an organization for a user without membership", async () => {
    await expect(requireOrganizationPermission(101, 999, "case:read")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Organization resource not found",
    } satisfies Partial<TRPCError>);
  });

  it("rejects a disallowed action even for an active member", async () => {
    state.rows = [{ id: 1, organizationId: 7, userId: 101, role: "viewer", status: "active", organizationName: "Org", organizationSlug: "org", organizationStatus: "active", dataRegion: "KR", isolationMode: "shared_schema" }];
    await expect(requireOrganizationPermission(101, 7, "interpretation:edit")).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("returns only the verified membership and effective permissions", async () => {
    state.rows = [{ id: 2, organizationId: 7, userId: 101, role: "analyst", status: "active", organizationName: "Org", organizationSlug: "org", organizationStatus: "active", dataRegion: "KR", isolationMode: "shared_schema" }];
    const membership = await requireOrganizationPermission(101, 7, "case:create");
    expect(membership.organizationId).toBe(7);
    expect(membership.permissions).toContain("case:create");
    expect(membership.permissions).not.toContain("report:sign");
  });
});

import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission } from "./permissions";

describe("clinical action permission matrix", () => {
  it("gives administrators full permissions including report signing", () => {
    expect(roleHasPermission("administrator", "report:sign")).toBe(true);
    expect(roleHasPermission("administrator", "member:manage")).toBe(true);
    expect(roleHasPermission("clinician", "report:sign")).toBe(true);
    expect(roleHasPermission("clinician", "member:manage")).toBe(false);
  });

  it("prevents analysts from approving or signing interpretations", () => {
    expect(roleHasPermission("analyst", "interpretation:edit")).toBe(true);
    expect(roleHasPermission("analyst", "interpretation:approve")).toBe(false);
    expect(roleHasPermission("analyst", "report:sign")).toBe(false);
  });

  it("keeps viewer permissions read-only", () => {
    const mutating = ROLE_PERMISSIONS.viewer.filter(permission => permission.includes("create") || permission.includes("edit") || permission.includes("manage") || permission.includes("sign") || permission.includes("upload"));
    expect(mutating).toEqual([]);
  });

  it("defines every assigned permission in the canonical catalog", () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of permissions) expect(PERMISSIONS).toContain(permission);
    }
  });
});

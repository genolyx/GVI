import { describe, expect, it } from "vitest";
import { orderTenantDeletes } from "./organizationDelete";

describe("organization delete order", () => {
  it("deletes a child table before the parent it references", () => {
    const ordered = orderTenantDeletes(
      ["organizations_skipped", "cases", "variants", "projects"],
      [
        { child: "cases", parent: "projects" },
        { child: "variants", parent: "cases" },
      ]
    );
    expect(ordered.indexOf("variants")).toBeLessThan(ordered.indexOf("cases"));
    expect(ordered.indexOf("cases")).toBeLessThan(ordered.indexOf("projects"));
  });

  it("ignores foreign keys that leave the tenant tables", () => {
    expect(
      orderTenantDeletes(["cases"], [{ child: "cases", parent: "users" }])
    ).toEqual(["cases"]);
  });

  it("rejects a cycle among tenant tables", () => {
    expect(() =>
      orderTenantDeletes(
        ["a", "b"],
        [
          { child: "a", parent: "b" },
          { child: "b", parent: "a" },
        ]
      )
    ).toThrow(/cycle/);
  });
});

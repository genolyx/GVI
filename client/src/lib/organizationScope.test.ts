import { describe, expect, it } from "vitest";
import { pathAfterOrganizationChange } from "./organizationScope";

describe("pathAfterOrganizationChange", () => {
  it("leaves a case workflow for the workbench home", () => {
    expect(pathAfterOrganizationChange("/workbench/42")).toBe("/workbench");
  });

  it("leaves a batch review for the workbench home", () => {
    expect(pathAfterOrganizationChange("/workbench/batches/3/review/9")).toBe("/workbench");
  });

  it("leaves a case or report detail for that section's list", () => {
    expect(pathAfterOrganizationChange("/cases/7")).toBe("/cases");
    expect(pathAfterOrganizationChange("/cases/new")).toBe("/cases");
    expect(pathAfterOrganizationChange("/reports/4")).toBe("/reports");
  });

  it("keeps organization-wide pages", () => {
    expect(pathAfterOrganizationChange("/workbench")).toBeNull();
    expect(pathAfterOrganizationChange("/workbench/germline")).toBeNull();
    expect(pathAfterOrganizationChange("/workbench/somatic")).toBeNull();
    expect(pathAfterOrganizationChange("/cases")).toBeNull();
    expect(pathAfterOrganizationChange("/")).toBeNull();
  });
});

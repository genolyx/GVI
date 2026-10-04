import { describe, expect, it } from "vitest";
import { caseDisplayName } from "./caseLabel";

describe("caseDisplayName", () => {
  it("uses the order id when the case number is an internal hash", () => {
    const hash = "a".repeat(64);
    expect(caseDisplayName(hash, "WEGX26100015")).toBe("WEGX26100015");
  });

  it("keeps a human case number", () => {
    expect(caseDisplayName("GVI-2026-0930", "Eugenia")).toBe("GVI-2026-0930");
  });
});
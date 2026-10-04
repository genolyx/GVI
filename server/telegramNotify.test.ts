import { describe, expect, it } from "vitest";
import { formatGvcMessage, telegramCaseSubject } from "./telegramNotify";

describe("telegram case subject", () => {
  it("shows the portal order id for a partner case", () => {
    const storageKey = "a5beeb1f4043c65234f30c63896bab821b4f8d42302954cc5c6e3a120e5fd8d1";
    expect(telegramCaseSubject(storageKey, "WEGX26100015")).toBe("WEGX26100015");
  });

  it("keeps a normal case number", () => {
    expect(telegramCaseSubject("CASE-42", "patient")).toBe("CASE-42");
  });

  it("puts the order id and the failure reason on the notice", () => {
    expect(
      formatGvcMessage(
        "WEGX26100015",
        "failed",
        "Choose a gene panel or enter HPO terms before running this VCF."
      )
    ).toBe(
      "[GVC]\nWEGX26100015 - Failed\nChoose a gene panel or enter HPO terms before running this VCF."
    );
  });
});

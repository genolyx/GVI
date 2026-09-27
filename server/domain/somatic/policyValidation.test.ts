import { describe, expect, it } from "vitest";
import { validateNegativeReportingPolicy } from "./policyValidation";

describe("validateNegativeReportingPolicy", () => {
  it("does not require an artifact while negative reporting is disabled", () => {
    expect(validateNegativeReportingPolicy(false, {})).toEqual({
      valid: true,
      validationArtifactHash: null,
    });
  });

  it("rejects activation without a SHA-256 validation artifact", () => {
    expect(
      validateNegativeReportingPolicy(true, {
        negativeReportingValidationArtifactHash: "not-a-hash",
      })
    ).toEqual({ valid: false, validationArtifactHash: null });
  });

  it("accepts a valid validation artifact hash", () => {
    const hash = "A".repeat(64);
    expect(
      validateNegativeReportingPolicy(true, {
        negativeReportingValidationArtifactHash: hash,
      })
    ).toEqual({
      valid: true,
      validationArtifactHash: hash.toLowerCase(),
    });
  });
});

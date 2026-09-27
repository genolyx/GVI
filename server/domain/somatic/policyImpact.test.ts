import { describe, expect, it } from "vitest";
import { classifyPolicyImpact } from "./policyImpact";

const base = {
  contentHash: "a".repeat(64),
  allowNegativeReporting: false,
  enableOncoKb: false,
};

describe("classifyPolicyImpact", () => {
  it("does not create impact for the initial or unchanged policy", () => {
    expect(classifyPolicyImpact(null, base).changed).toBe(false);
    expect(classifyPolicyImpact(base, base).changed).toBe(false);
  });

  it("classifies safety-control and general content changes", () => {
    expect(
      classifyPolicyImpact(base, {
        contentHash: "b".repeat(64),
        allowNegativeReporting: true,
        enableOncoKb: true,
      })
    ).toEqual({
      changed: true,
      changedControls: [
        "negative_reporting",
        "oncokb_enablement",
        "policy_content",
      ],
    });
  });

  it("classifies hash-only changes as policy content changes", () => {
    expect(
      classifyPolicyImpact(base, {
        ...base,
        contentHash: "c".repeat(64),
      })
    ).toEqual({
      changed: true,
      changedControls: ["policy_content"],
    });
  });
});

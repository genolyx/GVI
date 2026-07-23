import { describe, expect, it } from "vitest";
import {
  citationsBelongToVariant,
  COPILOT_SYSTEM_PROMPT,
  uniqueCitationIds,
} from "./copilotGuardrails";

describe("clinical copilot guardrails", () => {
  it("rejects citation IDs outside the selected variant evidence ledger", () => {
    expect(citationsBelongToVariant([11, 12], [11, 12, 13])).toBe(true);
    expect(citationsBelongToVariant([11, 99], [11, 12, 13])).toBe(false);
  });

  it("deduplicates citations without changing their order", () => {
    expect(uniqueCitationIds([7, 9, 7, 10])).toEqual([7, 9, 10]);
  });

  it("explicitly prohibits final clinical decisions and report signatures", () => {
    expect(COPILOT_SYSTEM_PROMPT).toContain("Never make a final ACMG/AMP classification");
    expect(COPILOT_SYSTEM_PROMPT).toContain("report signature");
    expect(COPILOT_SYSTEM_PROMPT).toContain("uncitedClaims");
  });
});

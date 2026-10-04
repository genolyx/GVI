import { describe, expect, it } from "vitest";
import { parseClassifierCaseLimit } from "./classifierLimit";

describe("classifier case limit", () => {
  it("accepts a whole number inside the allowed range", () => {
    expect(parseClassifierCaseLimit("200")).toBe(200);
    expect(parseClassifierCaseLimit(1)).toBe(1);
    expect(parseClassifierCaseLimit("5000")).toBe(5000);
  });

  it("rejects empty, fractional, and out-of-range values", () => {
    expect(parseClassifierCaseLimit("")).toBeNull();
    expect(parseClassifierCaseLimit("20.5")).toBeNull();
    expect(parseClassifierCaseLimit(0)).toBeNull();
    expect(parseClassifierCaseLimit(5001)).toBeNull();
  });
});

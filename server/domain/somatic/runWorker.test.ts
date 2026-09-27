import { describe, expect, it } from "vitest";
import { somaticRetryDelayMs } from "./runWorker";

describe("somaticRetryDelayMs", () => {
  it("uses bounded exponential retry delays", () => {
    expect(somaticRetryDelayMs(1)).toBe(1_000);
    expect(somaticRetryDelayMs(2)).toBe(2_000);
    expect(somaticRetryDelayMs(3)).toBe(4_000);
    expect(somaticRetryDelayMs(20)).toBe(60_000);
  });
});

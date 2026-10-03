import { describe, expect, it } from "vitest";
import { classifierWorkerName, parseClassifierWorkerCount } from "./curationWorker";

describe("classifier worker count", () => {
  it("keeps a count from 1 to 4", () => {
    expect(parseClassifierWorkerCount("1")).toBe(1);
    expect(parseClassifierWorkerCount("4")).toBe(4);
  });

  it("clamps an out-of-range count", () => {
    expect(parseClassifierWorkerCount("0")).toBe(1);
    expect(parseClassifierWorkerCount("9")).toBe(4);
  });

  it("uses four workers when the setting has not been saved", () => {
    expect(parseClassifierWorkerCount("")).toBe(4);
    expect(parseClassifierWorkerCount(null)).toBe(4);
  });

  it("names slots Worker-0 through Worker-3", () => {
    expect(classifierWorkerName(0)).toBe("Worker-0");
    expect(classifierWorkerName(3)).toBe("Worker-3");
  });
});

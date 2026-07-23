import { describe, expect, it } from "vitest";
import { canTransitionReport, createReportDigest, isReportMutable } from "./reportSnapshot";

describe("report immutability policy", () => {
  it("allows only controlled report transitions", () => {
    expect(canTransitionReport("draft", "in_review")).toBe(true);
    expect(canTransitionReport("in_review", "signed")).toBe(true);
    expect(canTransitionReport("signed", "draft")).toBe(false);
    expect(canTransitionReport("amended", "signed")).toBe(false);
  });
  it("produces the same digest regardless of object key order", () => {
    expect(createReportDigest({ b: 2, a: { y: 1, x: 0 } }).sha256).toBe(createReportDigest({ a: { x: 0, y: 1 }, b: 2 }).sha256);
  });
  it("changes the digest when signed content changes", () => {
    expect(createReportDigest({ content: "A" }).sha256).not.toBe(createReportDigest({ content: "B" }).sha256);
  });
  it("makes every reviewed or signed version immutable", () => {
    expect(isReportMutable("draft")).toBe(true);
    expect(isReportMutable("in_review")).toBe(false);
    expect(isReportMutable("signed")).toBe(false);
    expect(isReportMutable("amended")).toBe(false);
  });
});

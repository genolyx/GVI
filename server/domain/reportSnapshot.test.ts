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
  it("canonicalizes a somatic report snapshot while preserving array order", () => {
    const digest = createReportDigest({
      template: {
        schema: {
          sections: [
            { title: "Findings", id: "significant_findings" },
            { title: "Limitations", id: "limitations" },
          ],
          schemaVersion: "1",
        },
        versionId: 8,
      },
      schemaVersion: "somatic-report-snapshot-2",
      assertions: [
        { tier: "Tier I", assertionId: 21 },
        { tier: "Tier III", assertionId: 34 },
      ],
    });

    expect(digest.canonicalJson).toMatchInlineSnapshot(
      `"{"assertions":[{"assertionId":21,"tier":"Tier I"},{"assertionId":34,"tier":"Tier III"}],"schemaVersion":"somatic-report-snapshot-2","template":{"schema":{"schemaVersion":"1","sections":[{"id":"significant_findings","title":"Findings"},{"id":"limitations","title":"Limitations"}]},"versionId":8}}"`
    );
    expect(digest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("binds the digest to the template version and signature", () => {
    const snapshot = {
      template: { versionId: 3, schema: { schemaVersion: "1" } },
      signature: { userId: 7, signedAt: "2026-09-27T08:00:00.000Z" },
    };

    expect(createReportDigest(snapshot).sha256).not.toBe(
      createReportDigest({
        ...snapshot,
        template: { ...snapshot.template, versionId: 4 },
      }).sha256
    );
    expect(createReportDigest(snapshot).sha256).not.toBe(
      createReportDigest({
        ...snapshot,
        signature: { ...snapshot.signature, userId: 9 },
      }).sha256
    );
  });
  it("makes every reviewed or signed version immutable", () => {
    expect(isReportMutable("draft")).toBe(true);
    expect(isReportMutable("in_review")).toBe(false);
    expect(isReportMutable("signed")).toBe(false);
    expect(isReportMutable("amended")).toBe(false);
  });
});

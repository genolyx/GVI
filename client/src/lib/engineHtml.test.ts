// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { engineHtmlToText, sanitizeEngineHtml } from "./engineHtml";

describe("engine HTML sanitisation", () => {
  it("keeps the inline markup the engine actually uses", () => {
    const clean = sanitizeEngineHtml(
      "<b>Product 1 (loss / exon skip)</b><br/>canonical acceptor loss &rarr; <span style=\"color:#f00\">whole-exon skip</span>"
    );
    expect(clean).toContain("<b>Product 1 (loss / exon skip)</b>");
    expect(clean).toContain("<br>");
    expect(clean).toContain("whole-exon skip");
  });

  it("drops script tags but keeps their surrounding text", () => {
    const clean = sanitizeEngineHtml("before<script>alert(1)</script>after");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("alert(1)");
    expect(clean).toContain("before");
    expect(clean).toContain("after");
  });

  it("removes inline event handlers", () => {
    const clean = sanitizeEngineHtml('<span onmouseover="steal()">PVS1</span>');
    expect(clean).not.toContain("onmouseover");
    expect(clean).toContain("PVS1");
  });

  it("blocks javascript: URLs on engine links", () => {
    const clean = sanitizeEngineHtml('<a href="javascript:alert(1)">ClinVar</a>');
    expect(clean).not.toContain("javascript:");
  });

  it("forces external links to open without leaking the referrer", () => {
    const clean = sanitizeEngineHtml('<a href="https://www.ncbi.nlm.nih.gov/clinvar/">View</a>');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain("noreferrer");
  });

  it("drops img and iframe entirely", () => {
    expect(sanitizeEngineHtml('<img src="x" onerror="alert(1)">')).not.toContain("img");
    expect(sanitizeEngineHtml('<iframe src="https://evil.test"></iframe>')).not.toContain("iframe");
  });

  it("returns an empty string for absent or blank input", () => {
    expect(sanitizeEngineHtml(null)).toBe("");
    expect(sanitizeEngineHtml(undefined)).toBe("");
    expect(sanitizeEngineHtml("   ")).toBe("");
    expect(sanitizeEngineHtml(42)).toBe("");
  });

  it("flattens markup to text when only text is wanted", () => {
    expect(engineHtmlToText("<b>PVS1</b><br/>downgraded to <i>Strong</i>")).toBe(
      "PVS1 downgraded to Strong"
    );
    expect(engineHtmlToText("<script>alert(1)</script>plain")).toBe("plain");
  });
});

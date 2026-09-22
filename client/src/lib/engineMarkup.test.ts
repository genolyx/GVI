// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EngineMarkup, engineHtmlToReact } from "./engineMarkup";

function markup(html: unknown): string {
  return renderToStaticMarkup(createElement(EngineMarkup, { html, className: "engine-narrative" }));
}

describe("engine HTML → React tree", () => {
  it("keeps emphasis and line breaks as React elements", () => {
    const html = markup("<b>Product 1</b><br/>canonical acceptor loss");
    expect(html).toContain("<b>Product 1</b>");
    expect(html).toContain("<br");
    expect(html).toContain("canonical acceptor loss");
  });

  it("keeps a colour style the splice narrative uses", () => {
    const html = markup('<span style="color:#f00">whole-exon skip</span>');
    expect(html).toContain("color:#f00");
    expect(html).toContain("whole-exon skip");
  });

  it("drops a script even if sanitization were skipped", () => {
    const html = markup("before<script>alert(1)</script>after");
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("rewrites links to open without a referrer", () => {
    const html = markup('<a href="https://www.ncbi.nlm.nih.gov/clinvar/">View</a>');
    expect(html).toContain("noreferrer");
    expect(html).toContain('target="_blank"');
  });

  it("returns null for blank input", () => {
    expect(engineHtmlToReact("")).toBeNull();
    expect(engineHtmlToReact(null)).toBeNull();
    expect(markup("")).toBe("");
  });
});

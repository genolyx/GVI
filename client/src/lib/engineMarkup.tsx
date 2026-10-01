import { createElement, type ReactNode } from "react";
import { sanitizeEngineHtml } from "./engineHtml";

/**
 * Turns sanitized engine HTML into a React tree.
 *
 * Phase A rendered the engine's narrative with `dangerouslySetInnerHTML` after
 * DOMPurify. Phase C keeps the same allow-list but never injects a string into
 * the DOM: every tag becomes a React element, so a missed sanitizer rule cannot
 * become a script node.
 */

const ALLOWED_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "sub",
  "sup",
  "br",
  "p",
  "div",
  "span",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "code",
  "pre",
  "small",
  "a",
]);

const VOID_TAGS = new Set(["br"]);

/**
 * Near-white hex colours are body text for the dark review page.
 * On a light card they disappear, so the narrative falls back to the theme colour.
 */
function readableColor(color: string): string | null {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return color;
  let raw = hex[1];
  if (raw.length === 3) raw = raw.split("").map(channel => channel + channel).join("");
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  if (red >= 210 && green >= 210 && blue >= 210) return null;
  return color;
}

/** Only colour is used by the engine (splice product highlighting). */
function styleFrom(raw: string | null): { color?: string } | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  const color = match?.[1]?.trim();
  if (!color || /expression|url\s*\(|javascript:/i.test(color)) return undefined;
  const kept = readableColor(color);
  if (!kept) return undefined;
  return { color: kept };
}

function walk(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map((child, index) => walk(child, index));
  if (!ALLOWED_TAGS.has(tag)) return children;
  if (VOID_TAGS.has(tag)) return createElement(tag, { key });

  const props: Record<string, unknown> = { key };
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href) props.href = href;
    props.target = "_blank";
    props.rel = "noreferrer noopener";
    const title = el.getAttribute("title");
    if (title) props.title = title;
  }
  const style = styleFrom(el.getAttribute("style"));
  if (style) props.style = style;
  const colSpan = el.getAttribute("colspan");
  const rowSpan = el.getAttribute("rowspan");
  if (colSpan) props.colSpan = Number(colSpan) || undefined;
  if (rowSpan) props.rowSpan = Number(rowSpan) || undefined;

  return createElement(tag, props, ...children);
}

export function engineHtmlToReact(raw: unknown): ReactNode {
  const html = sanitizeEngineHtml(raw);
  if (!html) return null;
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div id="gvi-root">${html}</div>`, "text/html");
  const root = doc.getElementById("gvi-root");
  if (!root) return null;
  const nodes = Array.from(root.childNodes).map((child, index) => walk(child, index));
  return nodes.length === 1 ? nodes[0] : nodes;
}

export function EngineMarkup({ html, className }: { html: unknown; className?: string }) {
  const tree = engineHtmlToReact(html);
  if (!tree) return null;
  return createElement("div", { className }, tree);
}

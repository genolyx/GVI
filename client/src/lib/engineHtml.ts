import DOMPurify from "dompurify";

/**
 * The single place engine-rendered HTML becomes DOM.
 *
 * The curation engine composes narrative blocks by string-concatenating values it
 * fetched from ClinVar, HGMD, UniProt and NCBI. Those strings are attacker-reachable
 * in the sense that they are third-party content the engine does not escape, so the
 * markup is never trusted regardless of how it looks in the baselines.
 *
 * The allow-list is deliberately narrow: the engine only needs inline emphasis,
 * line breaks, simple grouping and links. Anything else is dropped rather than
 * escaped, because a stray tag in a clinical narrative is noise either way.
 */

const ALLOWED_TAGS = [
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
];

/**
 * `style` is allowed because the engine colour-codes splicing products and losing
 * it makes several narratives unreadable. DOMPurify still strips `expression()`,
 * `url()` and behaviour properties from inline styles.
 */
const ALLOWED_ATTR = ["href", "target", "rel", "title", "colspan", "rowspan", "style", "class"];

let hookInstalled = false;

function installHooks() {
  if (hookInstalled) return;
  hookInstalled = true;
  // Force external links to open safely. `target=_blank` without `noreferrer`
  // hands the opened page a reference back to this one.
  DOMPurify.addHook("afterSanitizeAttributes", node => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
}

/** Sanitise one engine HTML block. Returns "" for absent or empty input. */
export function sanitizeEngineHtml(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  installHooks();
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Block javascript:, data: and vbscript: URLs in href.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["srcset", "src", "formaction", "action", "background"],
    KEEP_CONTENT: true,
  });
}

/** Tags that separate words visually and so must leave whitespace behind. */
const BLOCK_BOUNDARY = /<\s*\/?\s*(br|p|div|li|tr|td|th|ul|ol|table|thead|tbody)\b[^>]*>/gi;

/**
 * Strip all markup, for text-only contexts such as report findings.
 *
 * Break and block tags become spaces first: dropping `<br>` outright would fuse the
 * words on either side, which is how "PVS1<br>downgraded" turns into
 * "PVS1downgraded" in a clinical report.
 */
export function engineHtmlToText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const spaced = raw.replace(BLOCK_BOUNDARY, " ");
  const clean = DOMPurify.sanitize(spaced, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  });
  return clean.replace(/\s+/g, " ").trim();
}

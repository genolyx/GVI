import type { CurationDocument } from "@shared/curation/document";
import { useEffect, useRef, useState } from "react";

type AnalyzeResult = {
  parsed_data: Record<string, unknown>;
  results_acmg: unknown;
  results_custom: unknown;
  literature: unknown;
  gene_summary: string | null;
  effective_gene: string | null;
};

declare global {
  interface Window {
    ClassifierParsedPanel?: {
      renderClassifierParsedPanel: (result: AnalyzeResult) => { html: string };
    };
  }
}

const SCRIPTS = [
  "/samvc/splice-viz.js?v=exon-teal",
  "/samvc/junction-align-viz.js",
  "/samvc/copy-paste-builder.js",
  "/samvc/classifier-parsed-panel.js?v=logic-evidence-19",
];

let scriptsPromise: Promise<void> | null = null;

function ensureSamVcTheme() {
  let link = document.querySelector<HTMLLinkElement>("link[data-samvc-theme]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.dataset.samvcTheme = "1";
    document.head.appendChild(link);
  }
  // New URL every visit so a previously cached sheet cannot keep the old colors.
  link.href = new URL(`/samvc/classifier-theme.css?v=${Date.now()}`, window.location.origin).href;
}

function loadSamVcScripts() {
  ensureSamVcTheme();
  if (!scriptsPromise) {
    scriptsPromise = (async () => {
      ensureSamVcTheme();
      for (const src of SCRIPTS) {
        if (document.querySelector(`script[src="${src}"]`)) continue;
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = src;
          script.async = false;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error(`Failed to load ${src}`));
          document.body.appendChild(script);
        });
      }
    })();
  }
  return scriptsPromise;
}

function analyzeResult(document: CurationDocument): AnalyzeResult {
  return {
    parsed_data: document.engine.parsedData,
    results_acmg: document.engine.resultsAcmg,
    results_custom: document.engine.resultsCustom,
    literature: document.engine.literature,
    gene_summary: document.engine.geneSummary,
    effective_gene: document.variant.effectiveGene,
  };
}

/**
 * SAM-VC's classifier review panel, fed by the same engine JSON the workbench stores.
 *
 * The renderer is the workbench's own `classifier-parsed-panel.js`. Rebuilding that
 * layout in React would drift the moment the engine adds a fact; this keeps the
 * annotation identical, including exon maps, ClinVar pills, and literature sections.
 */
export function SamVcPanel({ document }: { document: CurationDocument }) {
  const detailRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    ensureSamVcTheme();
    const result = analyzeResult(document);
    setError("");
    loadSamVcScripts()
      .then(() => {
        if (cancelled) return;
        const render = window.ClassifierParsedPanel?.renderClassifierParsedPanel;
        if (!render || !detailRef.current) {
          setError("Classifier panel did not load.");
          return;
        }
        const gene = (result.effective_gene || document.variant.gene || "").toUpperCase();
        if (profileRef.current) {
          let summary = result.gene_summary || "";
          summary = summary.replace(
            "Mechanism treated as <b>Unknown</b> for PVS1.",
            "Mechanism unknown — look up.",
          );
          profileRef.current.innerHTML = summary
            ? `<div class="gene-profile-header">Gene Profile: ${gene}</div><div class="gene-profile-content">${summary}</div>`
            : "";
        }
        const { html } = render(result);
        if (detailRef.current) detailRef.current.innerHTML = html;
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render annotation");
      });
    return () => {
      cancelled = true;
    };
  }, [document]);

  return (
    <div className="samvc-review space-y-4 text-foreground">
      {error ? <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-800 dark:text-rose-100">{error}</p> : null}
      <div ref={profileRef} className="gene-profile-panel empty:hidden" />
      <div>
        <div className="eval-section-title mb-2">Classification detail</div>
        <div ref={detailRef} />
      </div>
    </div>
  );
}

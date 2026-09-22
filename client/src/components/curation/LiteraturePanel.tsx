import { Badge } from "@/components/ui/badge";
import { sanitizeEngineHtml } from "@/lib/engineHtml";
import type { Literature } from "@shared/curation/viz";
import { AlertTriangle, BookOpen, ExternalLink } from "lucide-react";

/**
 * Literature evidence from the engine's PubMed download and summarize passes.
 *
 * Literature is best-effort in the engine: a failed fetch records a status and the ACMG
 * result stands without it. That distinction matters to a reviewer, so a failure is
 * shown as an explicit warning rather than an empty panel that reads like "no papers
 * found" -- absence of evidence and absence of a successful search are different
 * claims, and only one of them is safe to cite in a report.
 */

const STATUS_LABEL: Record<string, string> = {
  ok: "Summarized",
  skipped: "Not run",
  no_folder: "No documents retrieved",
  download_failed: "PubMed fetch failed",
  summarize_failed: "Summarization failed",
  error: "Error",
};

/** Statuses where the panel has nothing trustworthy to show. */
const FAILURE_STATUSES = new Set(["download_failed", "summarize_failed", "error", "no_folder"]);

function PmidLinks({ pmids }: { pmids: string[] }) {
  if (!pmids.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {pmids.map(pmid => (
        <a
          key={pmid}
          href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] text-foreground hover:bg-muted"
        >
          {pmid}
          <ExternalLink className="h-2.5 w-2.5 opacity-60" />
        </a>
      ))}
    </div>
  );
}

function Summary({ title, html }: { title: string; html: string }) {
  const clean = sanitizeEngineHtml(html);
  if (!clean) return null;
  return (
    <div>
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div
        className="engine-narrative text-[11px] leading-5"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    </div>
  );
}

export function LiteraturePanel({
  literature,
  /** Extra PMIDs the engine pulled from the HGMD export, outside the search index. */
  hgmdPmids = [],
}: {
  literature: Literature | null;
  hgmdPmids?: string[];
}) {
  const status = literature?.status || "skipped";
  const failed = FAILURE_STATUSES.has(status);
  const indexPmids = (literature?.local_index?.pmids || []).map(String);
  const hitCount = literature?.local_index?.hit_count ?? null;
  const clinical = literature?.clinical_summary || "";
  const functional = literature?.functional_summary || "";
  const hasSummary = Boolean(clinical || functional);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700">
          <BookOpen className="h-3 w-3" />
          Literature
        </p>
        <Badge
          variant={status === "ok" ? "secondary" : failed ? "destructive" : "outline"}
          className="text-[8px]"
        >
          {STATUS_LABEL[status] || status}
        </Badge>
      </div>

      {failed ? (
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="text-[10px] font-medium leading-4 text-amber-900">
              The literature pass did not complete, so this panel is not a statement that no
              papers exist. Search PubMed manually before citing literature evidence.
            </p>
            {literature?.error ? (
              <p className="font-mono text-[9px] leading-4 text-amber-800">{literature.error}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {status === "skipped" && !hasSummary ? (
        <p className="rounded-lg border border-dashed px-3 py-5 text-center text-[10px] text-muted-foreground">
          No literature search was run for this variant.
        </p>
      ) : null}

      {hitCount !== null || indexPmids.length ? (
        <div className="space-y-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Local index
            {hitCount !== null ? (
              <span className="ml-1 font-normal normal-case tracking-normal">
                {hitCount} hit{hitCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
          {literature?.local_index?.query ? (
            <p className="font-mono text-[9px] leading-4 text-muted-foreground">
              {literature.local_index.query}
            </p>
          ) : null}
          <PmidLinks pmids={indexPmids} />
        </div>
      ) : null}

      {hgmdPmids.length ? (
        <div className="space-y-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            HGMD-cited PMIDs
          </p>
          <PmidLinks pmids={hgmdPmids} />
        </div>
      ) : null}

      <Summary title="Clinical summary" html={clinical} />
      <Summary title="Functional summary" html={functional} />

      {hasSummary ? (
        <p className="border-t border-border/60 pt-2 text-[9px] leading-4 text-muted-foreground">
          Summaries are machine-generated from the retrieved full texts. Read the source
          papers before citing them as PS3, PS4 or PP1 evidence.
        </p>
      ) : null}
    </div>
  );
}

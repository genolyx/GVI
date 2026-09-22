import { JunctionAlign, JunctionAlignSummary } from "@/components/curation/JunctionAlign";
import { LiteraturePanel } from "@/components/curation/LiteraturePanel";
import { SpliceMap } from "@/components/curation/SpliceMap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EngineMarkup } from "@/lib/engineMarkup";
import { trpc } from "@/lib/trpc";
import type { CurationDocument } from "@shared/curation/document";
import {
  junctionAlignSchema,
  literatureSchema,
  readVizPayload,
  spliceVizSchema,
} from "@shared/curation/viz";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Renders one CurationDocument.
 *
 * Shared by the case-bound Workbench tab and the ad-hoc `/curate` page, because the
 * document is the same artifact in both places and a reviewer who learns the layout on
 * one should not meet a different one on the other. The ad-hoc page simply has no
 * interpretation to accept criteria into, which it signals by omitting `interpretation`.
 *
 * Everything here shows the engine's own output rather than a GVI reinterpretation of
 * it: the scores it resolved, the criteria it applied, the products it predicted, and
 * the narrative it composed. Engine HTML is sanitized and then parsed into a React
 * tree — it never enters the DOM as a string.
 *
 * Narrative and visualization payloads are read from `document.engine.parsedData` by
 * name. That is the pass-through layer, untyped on purpose so an engine release can add
 * a fact without a contract change. The consequence is that a renamed key shows as a
 * missing section rather than a compile error, which is why every block is optional.
 */
type NarrativeBlock = { key: string; title: string; description?: string };

/** General narrative blocks, keyed by their `parsed_data` name. */
const NARRATIVE_BLOCKS: NarrativeBlock[] = [
  {
    key: "logic_explanation",
    title: "Classification logic",
    description: "How the engine reached its suggested classification",
  },
  {
    key: "clinical_publication_summary_html",
    title: "Clinical notes and pedigree",
    description: "Chart notes and inheritance detail submitted with the case",
  },
];

/**
 * Splicing prose, shown under the exon map rather than with the general narrative.
 *
 * These blocks are the engine's reasoning about the same products the map draws, and
 * reading them apart from the picture loses the connection between the two.
 */
const SPLICE_NARRATIVE_BLOCKS: NarrativeBlock[] = [
  {
    key: "splice_frame_math",
    title: "Splicing products and frame arithmetic",
    description: "Predicted transcripts, reading-frame outcome and NMD assessment",
  },
  { key: "splice_products_panel_html", title: "Splice product detail" },
  { key: "spliceai_secondary_splice_frame_math", title: "Secondary donor analysis" },
  { key: "cryptic_splice_narrative", title: "Cryptic splice site" },
  { key: "deep_intronic_splice_html", title: "Deep intronic assessment" },
  { key: "junction_model_summary", title: "Junction model" },
];

const STRENGTH_LABELS: Record<string, string> = {
  stand_alone: "Stand-alone",
  very_strong: "Very strong",
  strong: "Strong",
  moderate: "Moderate",
  supporting: "Supporting",
};

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2);
  return value.toFixed(digits);
}

function ScoreRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <tr className="border-b border-border/50 last:border-0">
      <td className="py-1.5 pr-3 text-[10px] text-muted-foreground">{label}</td>
      <td className="py-1.5 font-mono text-[11px] font-medium">{value}</td>
      <td className="py-1.5 pl-3 text-[9px] text-muted-foreground">{hint || ""}</td>
    </tr>
  );
}

function ScoresTable({ document }: { document: CurationDocument }) {
  const { scores, variant } = document;
  const spliceAiMax = Math.max(
    scores.spliceAi.dsAg ?? 0,
    scores.spliceAi.dsAl ?? 0,
    scores.spliceAi.dsDg ?? 0,
    scores.spliceAi.dsDl ?? 0
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="shadow-none">
        <CardContent className="p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            In silico and population
          </p>
          <table className="w-full">
            <tbody>
              <ScoreRow
                label="gnomAD AF"
                value={formatNumber(scores.gnomadAf, 6)}
                hint={scores.gnomadAf === null ? "not found" : ""}
              />
              <ScoreRow label="CADD (phred)" value={formatNumber(scores.caddPhred, 1)} />
              <ScoreRow label="REVEL" value={formatNumber(scores.revelScore, 3)} />
              <ScoreRow
                label="SpliceAI max Δ"
                value={formatNumber(spliceAiMax, 2)}
                hint={scores.spliceAi.fetched ? scores.spliceAi.source || "" : "not fetched"}
              />
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardContent className="p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            SpliceAI deltas
          </p>
          <table className="w-full">
            <tbody>
              <ScoreRow label="Acceptor gain" value={formatNumber(scores.spliceAi.dsAg)} hint={`pos ${scores.spliceAi.dpAg ?? "—"}`} />
              <ScoreRow label="Acceptor loss" value={formatNumber(scores.spliceAi.dsAl)} hint={`pos ${scores.spliceAi.dpAl ?? "—"}`} />
              <ScoreRow label="Donor gain" value={formatNumber(scores.spliceAi.dsDg)} hint={`pos ${scores.spliceAi.dpDg ?? "—"}`} />
              <ScoreRow label="Donor loss" value={formatNumber(scores.spliceAi.dsDl)} hint={`pos ${scores.spliceAi.dpDl ?? "—"}`} />
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardContent className="p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Pangolin
          </p>
          <table className="w-full">
            <tbody>
              <ScoreRow label="Splice gain" value={formatNumber(scores.pangolin.dsSg)} hint={`pos ${scores.pangolin.dpSg ?? "—"}`} />
              <ScoreRow label="Splice loss" value={formatNumber(scores.pangolin.dsSl)} hint={`pos ${scores.pangolin.dpSl ?? "—"}`} />
              <ScoreRow
                label="Fetched"
                value={scores.pangolin.fetched ? "yes" : "no"}
              />
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardContent className="p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Transcript context
          </p>
          <table className="w-full">
            <tbody>
              <ScoreRow label="Transcript" value={variant.transcript || "—"} />
              <ScoreRow
                label="Exon"
                value={
                  variant.exon.rank === null
                    ? "—"
                    : `${variant.exon.rank}${variant.exon.total ? ` / ${variant.exon.total}` : ""}`
                }
                hint={
                  variant.exon.codingRank !== null
                    ? `coding ${variant.exon.codingRank}/${variant.exon.codingTotal ?? "?"}`
                    : ""
                }
              />
              <ScoreRow label="Consequence" value={variant.consequence || "—"} />
              <ScoreRow label="Protein length" value={variant.proteinLength?.toString() || "—"} />
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function AcmgPanel({
  document,
  organizationId,
  accept,
}: {
  document: CurationDocument;
  organizationId: number;
  accept?: CurationAcceptTarget;
}) {
  const saveCriterion = trpc.variants.saveCriterion.useMutation({
    onSuccess: async () => {
      await accept?.onAccepted();
      toast.success("Criterion recorded as reviewer-confirmed.");
    },
    onError: error => toast.error(error.message),
  });

  const classification = document.acmg.classification;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
              Engine suggestion
            </p>
            <p className="mt-1.5 text-sm font-semibold text-indigo-950">
              {classification?.label || "No classification produced"}
            </p>
            <p className="mt-1 text-[10px] text-indigo-800/80">
              {document.acmg.criteria.length} criteria · engine {document.meta.engineVersion}
            </p>
          </div>
          <Badge variant="outline" className="border-indigo-300 bg-white/70 text-[9px] text-indigo-700">
            Advisory only
          </Badge>
        </div>
      </div>

      {document.meta.sourcesDisabled.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
          <p className="text-[10px] leading-4 text-amber-900">
            Not consulted for this run: {document.meta.sourcesDisabled.join(", ")}. Absence of
            evidence from a disabled source is not evidence of absence.
          </p>
        </div>
      ) : null}

      {document.meta.warnings.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
          {document.meta.warnings.map((warning, index) => (
            <p key={index} className="text-[10px] leading-4 text-amber-900">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        {document.acmg.criteria.length ? (
          document.acmg.criteria.map(criterion => (
            <Card key={criterion.code} className="shadow-none">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className={`font-mono text-[10px] ${
                        criterion.direction === "pathogenic"
                          ? "border-rose-200 bg-rose-50 text-rose-700"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {criterion.baseCode}
                    </Badge>
                    <Badge variant="secondary" className="text-[9px]">
                      {STRENGTH_LABELS[criterion.strength] || criterion.strength}
                    </Badge>
                    {criterion.code !== criterion.baseCode ? (
                      <span className="font-mono text-[9px] text-muted-foreground">
                        engine: {criterion.code}
                      </span>
                    ) : null}
                  </div>
                  {accept ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 text-[9px]"
                      disabled={saveCriterion.isPending}
                      onClick={() =>
                        saveCriterion.mutate({
                          organizationId,
                          interpretationId: accept.interpretationId,
                          code: criterion.baseCode as never,
                          state: "met",
                          strengthOverride: criterion.strength,
                          evidenceIds: [],
                          note: criterion.rationale || `Accepted engine suggestion ${criterion.code}`,
                        })
                      }
                    >
                      {saveCriterion.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        "Accept"
                      )}
                    </Button>
                  ) : null}
                </div>
                {criterion.rationale ? (
                  <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                    {criterion.rationale}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
            The engine applied no ACMG criteria to this variant.
          </p>
        )}
      </div>
    </div>
  );
}

/** Render whichever of `blocks` the engine actually emitted for this variant. */
function useNarrative(document: CurationDocument, blocks: NarrativeBlock[]) {
  return useMemo(
    () =>
      blocks
        .map(block => ({ ...block, html: document.engine.parsedData[block.key] }))
        .filter(block => typeof block.html === "string" && block.html.trim()),
    [document, blocks]
  );
}

function NarrativeCard({ block }: { block: NarrativeBlock & { html: unknown } }) {
  return (
    <Card className="shadow-none">
      <CardContent className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {block.title}
        </p>
        {block.description ? (
          <p className="mt-0.5 text-[9px] text-muted-foreground/80">{block.description}</p>
        ) : null}
        <EngineMarkup html={block.html} className="engine-narrative mt-2.5 text-[11px] leading-5" />
      </CardContent>
    </Card>
  );
}

function NarrativeBlocks({ document }: { document: CurationDocument }) {
  const blocks = useNarrative(document, NARRATIVE_BLOCKS);
  const geneSummary = document.engine.geneSummary;

  if (!blocks.length && !(typeof geneSummary === "string" && geneSummary.trim())) {
    return (
      <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
        The engine produced no narrative sections for this variant.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {geneSummary ? (
        <Card className="shadow-none">
          <CardContent className="p-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Gene summary
            </p>
            <EngineMarkup html={geneSummary} className="engine-narrative text-[11px] leading-5" />
          </CardContent>
        </Card>
      ) : null}
      {blocks.map(block => (
        <NarrativeCard key={block.key} block={block} />
      ))}
    </div>
  );
}

/**
 * Splicing view: the exon map, the base-level junction alignment, and the engine's
 * prose about the products both of them depict.
 *
 * The alignment starts collapsed. It is hundreds of nucleotide cells wide and only
 * matters once a reviewer has a specific question about a splice site, whereas the exon
 * map answers "what happens to the transcript" at a glance.
 */
function SplicingSection({ document }: { document: CurationDocument }) {
  const parsed = document.engine.parsedData;
  const spliceViz = useMemo(() => readVizPayload(parsed, "splice_viz", spliceVizSchema), [parsed]);
  const junction = useMemo(
    () => readVizPayload(parsed, "junction_align_viz", junctionAlignSchema),
    [parsed]
  );
  const blocks = useNarrative(document, SPLICE_NARRATIVE_BLOCKS);

  if (!spliceViz && !junction && !blocks.length) {
    return (
      <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
        The engine resolved no splicing consequence for this variant.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {spliceViz ? (
        <Card className="shadow-none">
          <CardContent className="p-4">
            <SpliceMap spliceViz={spliceViz} />
          </CardContent>
        </Card>
      ) : null}

      {junction && junction.eligible !== false ? (
        <Card className="shadow-none">
          <CardContent className="p-4">
            <details>
              <summary className="cursor-pointer">
                <JunctionAlignSummary payload={junction} />
                <span className="mt-0.5 block text-[9px] text-muted-foreground">
                  {junction.launcher_hint ||
                    "Base-level tracks with an HGVS ruler for every resolved splice product."}
                </span>
              </summary>
              <div className="mt-3 border-t border-border/60 pt-3">
                <JunctionAlign payload={junction} />
              </div>
            </details>
          </CardContent>
        </Card>
      ) : null}

      {blocks.map(block => (
        <NarrativeCard key={block.key} block={block} />
      ))}
    </div>
  );
}

function LiteratureSection({ document }: { document: CurationDocument }) {
  const literature = useMemo(() => {
    const raw = document.engine.literature;
    if (!raw || typeof raw !== "object") return null;
    const parsed = literatureSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }, [document]);

  // HGMD cites its own PMIDs outside the engine's PubMed search, so they are surfaced
  // even when the literature pass itself was skipped.
  const hgmdPmids = useMemo(() => {
    const raw = document.engine.parsedData.hgmd_excel_pmids;
    return Array.isArray(raw) ? raw.map(String).filter(pmid => /^\d+$/.test(pmid)) : [];
  }, [document]);

  return (
    <Card className="shadow-none">
      <CardContent className="p-4">
        <LiteraturePanel literature={literature} hgmdPmids={hgmdPmids} />
      </CardContent>
    </Card>
  );
}

type Section = "acmg" | "scores" | "splicing" | "literature" | "narrative";

const SECTIONS: [Section, string][] = [
  ["acmg", "ACMG"],
  ["scores", "Scores"],
  ["splicing", "Splicing"],
  ["literature", "Literature"],
  ["narrative", "Narrative"],
];
/** Where a reviewer can accept an engine criterion into a draft interpretation. */
export type CurationAcceptTarget = { interpretationId: number; onAccepted: () => void | Promise<unknown> };

export function CurationDocumentView({
  document,
  organizationId,
  documentHash,
  /** Omitted on the ad-hoc page, where there is no interpretation to write into. */
  accept,
  height = 440,
}: {
  document: CurationDocument;
  organizationId: number;
  documentHash?: string | null;
  accept?: CurationAcceptTarget;
  height?: number;
}) {
  const [section, setSection] = useState<Section>("acmg");

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {SECTIONS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setSection(value)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
              section === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
        {documentHash ? (
          <span className="ml-auto self-center font-mono text-[9px] text-muted-foreground">
            {documentHash.slice(0, 12)}
          </span>
        ) : null}
      </div>

      <ScrollArea className="pr-3" style={{ height }}>
        {section === "scores" ? (
          <ScoresTable document={document} />
        ) : section === "acmg" ? (
          <AcmgPanel document={document} organizationId={organizationId} accept={accept} />
        ) : section === "splicing" ? (
          <SplicingSection document={document} />
        ) : section === "literature" ? (
          <LiteratureSection document={document} />
        ) : (
          <NarrativeBlocks document={document} />
        )}
      </ScrollArea>
    </>
  );
}

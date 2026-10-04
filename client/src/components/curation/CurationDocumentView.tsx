import { JunctionAlign, JunctionAlignSummary } from "@/components/curation/JunctionAlign";
import { LiteraturePanel } from "@/components/curation/LiteraturePanel";
import { SpliceMap } from "@/components/curation/SpliceMap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EngineMarkup } from "@/lib/engineMarkup";
import { trpc } from "@/lib/trpc";
import { acmgEvidenceBoard, withoutRemovedCriteria } from "@shared/curation/acmgBoard";
import type { CurationDocument, CurationCriterion } from "@shared/curation/document";
import { hgmdPs4Check } from "@shared/curation/hgmdPs4";
import { criteriaWithSavedReview, savedStrength } from "@shared/curation/savedCriteria";
import { GERMLINE_CLASSIFICATIONS } from "@shared/clinical-standards";
import { INSTITUTIONAL_CLASSIFICATIONS } from "@shared/curation/institutional";
import { criteriaWithSpliceReview, spliceReviewCriterion } from "@shared/curation/spliceAcmg";
import {
  junctionAlignSchema,
  literatureSchema,
  readVizPayload,
  spliceVizSchema,
} from "@shared/curation/viz";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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

function AcmgColumn({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground/80">{hint}</p>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function CatalogRow({
  code,
  detail,
  suggestive = false,
  action,
  selected = false,
  editor,
  footnote,
}: {
  code: string;
  detail: string;
  suggestive?: boolean;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  selected?: boolean;
  editor?: ReactNode;
  footnote?: string;
}) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        suggestive
          ? "border-dashed border-sky-400 bg-sky-400/10"
          : selected
            ? "border-primary bg-card"
            : "border-border bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={`font-mono text-[10px] ${suggestive ? "border-sky-400 text-sky-800 dark:text-sky-200" : ""}`}>
            {code}
          </Badge>
          {suggestive ? <Badge variant="secondary" className="text-[9px]">Check</Badge> : null}
        </div>
        {action ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-[9px]"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      <p className={`mt-1.5 text-[10px] leading-4 ${suggestive ? "text-sky-900 dark:text-sky-100" : "text-muted-foreground"}`}>
        {detail}
      </p>
      {footnote ? <p className="mt-1 text-[10px] leading-4 text-amber-800 dark:text-amber-200">{footnote}</p> : null}
      {editor}
    </div>
  );
}

type CriterionDraft = {
  code: string;
  strength: string;
  state: "met" | "not_met" | "not_applicable";
  note: string;
};

function CriterionDraftForm({
  draft,
  pending,
  existing,
  onChange,
  onSave,
  onRemove,
  onCancel,
}: {
  draft: CriterionDraft;
  pending: boolean;
  existing: boolean;
  onChange: (next: CriterionDraft) => void;
  onSave: () => void;
  onRemove?: () => void;
  onCancel: () => void;
}) {
  const needsNote = draft.state === "met" && draft.note.trim().length < 2;
  return (
    <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
      <div className="flex gap-1.5">
        <select
          aria-label={`${draft.code} strength`}
          value={draft.strength}
          onChange={event => onChange({ ...draft, strength: event.target.value })}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[10px]"
        >
          <option value="very_strong">Very strong</option>
          <option value="strong">Strong</option>
          <option value="moderate">Moderate</option>
          <option value="supporting">Supporting</option>
          <option value="stand_alone">Stand-alone</option>
        </select>
        <select
          aria-label={`${draft.code} assessment`}
          value={draft.state}
          onChange={event =>
            onChange({ ...draft, state: event.target.value as CriterionDraft["state"] })
          }
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[10px]"
        >
          <option value="met">Met</option>
          <option value="not_met">Not met</option>
          <option value="not_applicable">N/A</option>
        </select>
      </div>
      <textarea
        aria-label={`${draft.code} note`}
        value={draft.note}
        onChange={event => onChange({ ...draft, note: event.target.value })}
        className="min-h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-4"
        placeholder="Record the basis for applying this code, or the reason for leaving it out."
      />
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-6 flex-1 text-[9px]" disabled={pending || needsNote} onClick={onSave}>
          {pending ? <Loader2 className="size-3 animate-spin" /> : existing ? `Save ${draft.code}` : `Apply ${draft.code}`}
        </Button>
        {onRemove ? (
          <Button size="sm" variant="outline" className="h-6 shrink-0 text-[9px]" disabled={pending} onClick={onRemove}>
            Delete
          </Button>
        ) : null}
        <Button size="sm" variant="outline" className="h-6 shrink-0 text-[9px]" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FoundCriterion({
  criterion,
  document,
  accept,
  spliceCode,
  spliceEngineCode,
  pending,
  onAccept,
  onEdit,
  onRemove,
  editor,
}: {
  criterion: CurationCriterion;
  document: CurationDocument;
  accept?: CurationAcceptTarget;
  spliceCode?: string;
  spliceEngineCode?: string;
  pending: boolean;
  onAccept: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  editor?: ReactNode;
}) {
  const saved = accept?.criteria?.find(item => item.code === criterion.baseCode);
  const savedMet = saved?.state === "met";
  const inEngine = document.acmg.criteria.some(
    item => item.baseCode === criterion.baseCode || item.code === criterion.code
  );
  const fromSpliceReview = !inEngine && spliceCode === criterion.baseCode && spliceEngineCode === criterion.code;
  const fromClassification = !inEngine && !fromSpliceReview;
  return (
    <Card className="shadow-none">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${
                criterion.direction === "pathogenic"
                  ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-300/30 dark:bg-rose-400/15 dark:text-rose-200"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-400/15 dark:text-emerald-200"
              }`}
            >
              {criterion.baseCode}
            </Badge>
            <Badge variant="secondary" className="text-[9px]">
              {STRENGTH_LABELS[criterion.strength] || criterion.strength}
            </Badge>
            {criterion.code !== criterion.baseCode ? (
              <span className="font-mono text-[9px] text-muted-foreground">engine: {criterion.code}</span>
            ) : null}
          </div>
          {accept ? (
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[9px]"
                disabled={pending}
                onClick={savedMet ? onEdit : onAccept}
              >
                {pending ? <Loader2 className="size-3 animate-spin" /> : savedMet ? "Edit" : "Accept"}
              </Button>
              {onRemove && (savedMet || inEngine || fromClassification) ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[9px]"
                  disabled={pending}
                  onClick={onRemove}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {criterion.rationale ? (
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{criterion.rationale}</p>
        ) : null}
        {fromSpliceReview && !savedMet ? (
          <p className="mt-1.5 text-[10px] text-indigo-800/80 dark:text-indigo-100/75">
            From the splice calculation review. Accepting it updates the classification above.
          </p>
        ) : null}
        {fromClassification ? (
          <p className="mt-1.5 text-[10px] text-indigo-800/80 dark:text-indigo-100/75">
            Added on the classification review.
          </p>
        ) : null}
        {editor}
      </CardContent>
    </Card>
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
  const [acceptedCall, setAcceptedCall] = useState<string | null>(null);
  const [draft, setDraft] = useState<CriterionDraft | null>(null);
  const [callDraft, setCallDraft] = useState("");
  const [institutionalDraft, setInstitutionalDraft] = useState("");
  useEffect(() => {
    setAcceptedCall(null);
    setDraft(null);
  }, [document]);
  const saveCriterion = trpc.variants.saveCriterion.useMutation({
    onSuccess: async result => {
      setAcceptedCall(result.classification);
      await accept?.onAccepted();
      toast.success(`Criterion saved. Classification is now ${result.classification}.`);
    },
    onError: error => toast.error(error.message),
  });

  const classification = document.acmg.classification;
  const criteria = useMemo(() => {
    const withSplice = criteriaWithSpliceReview(document.acmg.criteria, document.engine.parsedData);
    const withSaved = criteriaWithSavedReview(withSplice, accept?.criteria);
    return withoutRemovedCriteria(withSaved, accept?.criteria);
  }, [document, accept?.criteria]);
  const splice = spliceReviewCriterion(document.engine.parsedData);
  const ps4Check = hgmdPs4Check(
    document.engine.parsedData.hgmd_local,
    document.engine.parsedData.hgmd_excel_pmids
  );
  const board = useMemo(
    () => acmgEvidenceBoard(criteria, ps4Check),
    [criteria, ps4Check]
  );
  const splicePending = Boolean(
    splice &&
      !document.acmg.criteria.some(item => item.baseCode === splice.code || item.code === splice.engineCode) &&
      accept?.criteria?.find(item => item.code === splice.code)?.state !== "met"
  );
  const engineCall = acceptedCall || accept?.classification || classification?.label || "";
  const storedCall = accept?.savedCall ?? "";
  const storedInstitutional = accept?.institutionalLabel ?? "";
  useEffect(() => {
    setCallDraft(storedCall || engineCall);
  }, [storedCall, engineCall]);
  useEffect(() => {
    setInstitutionalDraft(storedInstitutional);
  }, [storedInstitutional]);
  const callDirty = Boolean(callDraft) && callDraft !== storedCall;
  const institutionalDirty = institutionalDraft !== storedInstitutional;
  const shownLabel = engineCall || "No classification produced";
  const callUpdated = Boolean(engineCall && classification?.label && engineCall !== classification.label);
  const pending = accept?.criterionPending || saveCriterion.isPending;

  function openDraft(code: string, preset?: { note?: string; strength?: string }) {
    const saved = accept?.criteria?.find(item => item.code === code);
    const kept = saved?.note?.trim();
    const note = kept && kept !== "Removed during review." ? kept : preset?.note || "";
    setDraft({
      code,
      strength: savedStrength(saved?.strength || preset?.strength, code),
      state: "met",
      note,
    });
  }

  function persistCriterion(payload: {
    code: string;
    state: "met" | "not_met" | "not_applicable";
    strength?: string;
    note?: string;
  }) {
    if (!accept) return;
    if (accept.onSaveCriterion) {
      accept.onSaveCriterion(payload);
      setDraft(null);
      return;
    }
    saveCriterion.mutate({
      organizationId,
      interpretationId: accept.interpretationId,
      code: payload.code as never,
      state: payload.state,
      strengthOverride: payload.strength as never,
      evidenceIds: [],
      note: payload.note,
    });
    setDraft(null);
  }

  function saveDraft() {
    if (!draft) return;
    persistCriterion({
      code: draft.code,
      state: draft.state,
      strength: draft.state === "met" ? draft.strength : undefined,
      note: draft.note.trim() || (draft.state === "met" ? undefined : "Removed during review."),
    });
  }

  function removeCriterion(code: string) {
    const saved = accept?.criteria?.find(item => item.code === code);
    persistCriterion({
      code,
      state: "not_met",
      note: saved?.note?.trim() || "Removed during review.",
    });
  }

  function editorFor(code: string, existing: boolean) {
    if (!draft || draft.code !== code) return null;
    return (
      <CriterionDraftForm
        draft={draft}
        pending={pending}
        existing={existing}
        onChange={setDraft}
        onSave={saveDraft}
        onRemove={existing ? () => removeCriterion(code) : undefined}
        onCancel={() => setDraft(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-card-foreground">
        <div className="flex flex-wrap items-end gap-x-2 gap-y-2">
          {accept?.onSaveCall ? (
            <>
              <label className="w-44">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Classification
                </span>
                <select
                  aria-label="Germline classification"
                  value={callDraft}
                  disabled={accept.callPending}
                  onChange={event => setCallDraft(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">Select classification</option>
                  {GERMLINE_CLASSIFICATIONS.map(value => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[10px]"
                disabled={!callDirty || accept.callPending}
                aria-label="Save classification"
                onClick={() => accept.onSaveCall?.(callDraft)}
              >
                {accept.callPending ? <Loader2 className="size-3 animate-spin" /> : "Save"}
              </Button>
            </>
          ) : (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Engine suggestion</p>
              <p className="text-sm font-semibold text-foreground">{shownLabel}</p>
            </div>
          )}
          {accept?.onSaveInstitutional ? (
            <>
              <label className="w-36">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Institutional
                </span>
                <select
                  aria-label="Institutional classification"
                  value={institutionalDraft}
                  disabled={accept.institutionalPending}
                  onChange={event => setInstitutionalDraft(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">Not set</option>
                  {INSTITUTIONAL_CLASSIFICATIONS.map(option => (
                    <option key={option.label} value={option.label}>
                      {option.short}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[10px]"
                disabled={!institutionalDirty || accept.institutionalPending}
                aria-label="Save institutional classification"
                onClick={() => accept.onSaveInstitutional?.(institutionalDraft)}
              >
                {accept.institutionalPending ? <Loader2 className="size-3 animate-spin" /> : "Save"}
              </Button>
            </>
          ) : null}
          <Badge variant="outline" className="mb-0.5 ml-auto h-6 text-[9px]">
            Advisory only
          </Badge>
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          {engineCall && callDraft && engineCall !== callDraft
            ? `Engine suggested ${engineCall}. `
            : engineCall
              ? "Same call as the engine suggestion. "
              : ""}
          {criteria.length} criteria · engine {document.meta.engineVersion}
          {callUpdated ? " · updated from saved criteria" : ""}
        </p>
        {splicePending ? (
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            The splice calculation meets PVS1. This call stays {classification?.label || "as saved"} until you accept it.
          </p>
        ) : null}
        {accept?.callDivergence ? (
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{accept.callDivergence}</p>
        ) : null}
      </div>

      {document.meta.sourcesDisabled.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-300/25 dark:bg-amber-300/10">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-200" />
          <p className="text-[10px] leading-4 text-amber-900 dark:text-amber-100">
            Not consulted for this run: {document.meta.sourcesDisabled.join(", ")}. Absence of
            evidence from a disabled source is not evidence of absence.
          </p>
        </div>
      ) : null}

      {document.meta.warnings.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-300/25 dark:bg-amber-300/10">
          {document.meta.warnings.map((warning, index) => (
            <p key={index} className="text-[10px] leading-4 text-amber-900 dark:text-amber-100">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-3 items-start gap-3">
        <AcmgColumn title="Found on this variant" hint="Evidence on this allele. Edit changes the note or strength. Delete takes it off the call.">
          {board.found.length ? (
            board.found.map(criterion => (
              <FoundCriterion
                key={criterion.code}
                criterion={criterion}
                document={document}
                accept={accept}
                spliceCode={splice?.code}
                spliceEngineCode={splice?.engineCode}
                pending={pending}
                onAccept={() =>
                  persistCriterion({
                    code: criterion.baseCode,
                    state: "met",
                    strength: criterion.strength,
                    note: criterion.rationale || `Accepted engine suggestion ${criterion.code}`,
                  })
                }
                onEdit={
                  accept
                    ? () => openDraft(criterion.baseCode, { note: criterion.rationale, strength: criterion.strength })
                    : undefined
                }
                onRemove={accept ? () => removeCriterion(criterion.baseCode) : undefined}
                editor={editorFor(criterion.baseCode, true)}
              />
            ))
          ) : (
            <p className="rounded-lg border border-dashed px-2 py-4 text-center text-[10px] text-muted-foreground">
              No ACMG evidence is applied to this variant.
            </p>
          )}
        </AcmgColumn>
        <AcmgColumn title="Wired, not applied" hint="The classifier can score these. Apply one when you have a reason it belongs.">
          {board.wired.map(item => (
            <CatalogRow
              key={item.code}
              code={item.code}
              detail={item.detail}
              selected={draft?.code === item.code}
              action={
                accept
                  ? {
                      label: draft?.code === item.code ? "Editing" : "Apply",
                      disabled: pending,
                      onClick: () => openDraft(item.code),
                    }
                  : undefined
              }
              editor={editorFor(item.code, false)}
            />
          ))}
        </AcmgColumn>
        <AcmgColumn title="Look up to add points" hint="These need a person. Apply one after you check the evidence.">
          {board.manual.map(item => {
            const suggestive = item.code === "PS4" && Boolean(ps4Check);
            return (
              <CatalogRow
                key={item.code}
                code={item.code}
                detail={item.detail}
                suggestive={suggestive}
                selected={draft?.code === item.code}
                action={
                  accept
                    ? {
                        label: draft?.code === item.code ? "Editing" : "Apply",
                        disabled: pending,
                        onClick: () => openDraft(item.code, suggestive ? { note: ps4Check?.note } : undefined),
                      }
                    : undefined
                }
                editor={editorFor(item.code, false)}
              />
            );
          })}
        </AcmgColumn>
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

function SplicePredictorScores({ document }: { document: CurationDocument }) {
  const { scores } = document;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="shadow-none">
        <CardContent className="p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            SpliceAI
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
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Splicing view: predictor scores, the exon map, the base-level junction alignment,
 * and the engine's prose about the products they depict.
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
  const showScores =
    document.scores.spliceAi.fetched ||
    document.scores.pangolin.fetched ||
    document.highlights.spliceApplicable;

  if (!spliceViz && !junction && !blocks.length && !showScores) {
    return (
      <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
        The engine resolved no splicing consequence for this variant.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {showScores ? <SplicePredictorScores document={document} /> : null}
      {spliceViz ? (
        <Card className="min-w-0 shadow-none">
          <CardContent className="min-w-0 p-4">
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
export type CurationAcceptTarget = {
  interpretationId: number;
  onAccepted: () => void | Promise<unknown>;
  /** Saved germline call. Shown in place of the frozen engine label after a criterion is accepted. */
  classification?: string | null;
  criteria?: { code: string; state: string; strength?: string | null; note?: string | null }[];
  /** Stored interpretation call. The classification select writes this. */
  savedCall?: string | null;
  onSaveCall?: (classification: string) => void;
  callPending?: boolean;
  callDivergence?: string | null;
  institutionalLabel?: string | null;
  onSaveInstitutional?: (label: string) => void;
  institutionalPending?: boolean;
  onSaveCriterion?: (input: {
    code: string;
    state: "met" | "not_met" | "not_applicable";
    strength?: string;
    note?: string;
  }) => void;
  criterionPending?: boolean;
};

export function CurationDocumentView({
  document,
  organizationId,
  documentHash,
  /** Omitted on the ad-hoc page, where there is no interpretation to write into. */
  accept,
  height = 820,
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

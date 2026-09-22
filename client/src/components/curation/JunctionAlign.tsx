import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  JunctionAlign as JunctionAlignPayload,
  JunctionSpan,
  JunctionTrack,
} from "@shared/curation/viz";
import { useEffect, useMemo, useRef } from "react";

/**
 * Base-level junction alignment, ported from the engine's `junction-align-viz.js`.
 *
 * Unlike the splice map this stays in the DOM rather than moving to SVG. The content is
 * sequence text a reviewer needs to select and paste into a primer design tool or a
 * variant caller, and `<text>` inside SVG selects a whole element at a time. A grid of
 * inline-block cells keeps the characters selectable in reading order.
 *
 * Reference and mutant pre-mRNA rows scroll together in one container so bases stay in
 * register; product rows are laid out at full width beneath them, since a product is
 * shorter than the genomic window and scrolling it independently would break alignment.
 */

/** Cell width in px. Every track shares it, which is what keeps columns aligned. */
const CELL_W = 14;

/** Track-name gutter. Shared by the pre-mRNA and product blocks so bases stay in column. */
const LABEL_WIDTH = 118;

/**
 * Per-kind colours. The engine names a role for each base and these map onto it; an
 * unrecognised kind falls back to intron styling rather than disappearing.
 */
const KIND_CLASS: Record<string, string> = {
  exon: "bg-blue-100 border-blue-400 text-blue-900",
  intron: "bg-slate-100 border-slate-300 text-slate-600",
  exon_extension: "bg-emerald-100 border-emerald-500 text-emerald-900",
  utr_extension: "bg-sky-100 border-sky-400 text-sky-900",
  exon_extension_intronic: "bg-emerald-50 border-emerald-400 text-emerald-800",
  exon_extension_prior_exon: "bg-emerald-200 border-emerald-500 text-emerald-900",
  splice_ag: "bg-amber-200 border-amber-500 text-amber-900",
  splice_gt: "bg-amber-200 border-amber-500 text-amber-900",
  splice_loss: "bg-rose-200 border-rose-500 text-rose-900 line-through",
  splice_gain: "bg-emerald-200 border-emerald-600 text-emerald-900",
  exon_deleted: "bg-slate-100 border-slate-400 text-slate-400",
  deleted: "bg-rose-100 border-rose-700 text-rose-700",
  exon_skip: "bg-rose-50 border-rose-400 text-rose-700",
  dup: "bg-slate-100 border-slate-300 text-slate-600",
  variant: "bg-slate-100 border-slate-300 text-slate-600",
  protein_gly: "bg-sky-100 border-sky-400 text-sky-900",
  protein_x: "bg-slate-100 border-slate-400 text-slate-700",
  protein_y: "bg-violet-100 border-violet-400 text-violet-900",
  protein_plain: "bg-slate-100 border-slate-400 text-slate-600",
  protein_variant: "bg-rose-200 border-rose-500 text-rose-900",
  ptc: "bg-rose-200 border-rose-600 text-rose-900",
  start_codon: "bg-green-200 border-green-600 text-green-900",
};

const LEGEND_SWATCH: Record<string, string> = {
  ...KIND_CLASS,
  dup: "bg-slate-100 border-b-[3px] border-b-rose-500 border-slate-300",
};

/** Half-open span lookup: the engine emits `[start, end)`. */
function spanAt(index: number, spans: JunctionSpan[], kind?: string): JunctionSpan | null {
  for (const span of spans) {
    if (kind && span.kind !== kind) continue;
    const start = Number(span.start);
    const end = Number(span.end);
    if (Number.isFinite(start) && Number.isFinite(end) && index >= start && index < end) return span;
  }
  return null;
}

function BaseCell({
  nt,
  kind,
  width,
  underline,
  marker,
  tooltip,
}: {
  nt: string;
  kind: string;
  width: number;
  underline: boolean;
  marker: string | null;
  tooltip: string;
}) {
  const base = KIND_CLASS[kind] || KIND_CLASS.intron;
  const markerClass =
    marker === "ptc"
      ? "outline outline-2 -outline-offset-1 outline-rose-500"
      : marker === "splice_ag_skipped"
        ? "border-b-2 border-b-dashed border-b-slate-400 opacity-80"
        : marker === "splice_ag" || marker === "splice_gt"
          ? "ring-1 ring-inset ring-amber-500"
          : marker === "splice_loss"
            ? "!bg-rose-200 !border-rose-500 !text-rose-900 line-through"
            : marker === "splice_gain"
              ? "!bg-emerald-200 !border-emerald-600 !text-emerald-900"
              : marker === "exon_start"
                ? "border-l-[3px] border-l-blue-500"
                : marker === "start_codon"
                  ? "!bg-green-200 !border-green-600 !text-green-900"
                  : marker === "variant_locus"
                    ? "outline outline-2 -outline-offset-1 outline-dashed outline-orange-500"
                    : "";
  return (
    <span
      title={tooltip}
      style={{ width }}
      className={`inline-block border text-center align-top font-mono text-[10px] leading-[16px] ${base} ${markerClass} ${
        underline ? "border-b-[3px] border-b-rose-500" : ""
      }`}
    >
      {nt}
    </span>
  );
}

function Ruler({ payload, width }: { payload: JunctionAlignPayload; width: number }) {
  const ticks = payload.ruler || [];
  if (!ticks.length) return null;
  return (
    <div className="relative mb-0.5 h-3.5" style={{ width }}>
      {ticks.map((tick, index) => (
        <span
          key={index}
          className="absolute top-0 whitespace-nowrap font-mono text-[8px] text-muted-foreground"
          style={{ left: Number(tick.index) * CELL_W - 2 }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

function TrackRow({ track, showTitle }: { track: JunctionTrack; showTitle: boolean }) {
  const bases = track.bases || [];
  const spans = track.spans || [];
  const markers = track.markers || [];

  const markerAt = useMemo(() => {
    const map = new Map<number, string>();
    for (const marker of markers) {
      if (marker.index !== null && marker.index !== undefined) {
        map.set(Number(marker.index), marker.kind || "");
      }
    }
    return map;
  }, [markers]);

  /** Labels the engine attached to spans and markers, shown under the sequence. */
  const annotations = useMemo(() => {
    const out: string[] = [];
    for (const span of spans) {
      if (!span.label) continue;
      if (span.kind === "ptc") out.push(`Ter: ${span.label}`);
      else if (["dup", "exon_extension", "utr_extension", "exon"].includes(span.kind || "")) {
        out.push(span.label);
      }
    }
    for (const marker of markers) {
      if (!marker.label) continue;
      if (marker.kind === "ptc") out.push(`PTC: ${marker.label}`);
      else out.push(marker.label);
    }
    return out;
  }, [spans, markers]);

  const codonAligned = track.codon_aligned === true;
  const trackWidth = codonAligned
    ? bases.reduce((sum, base) => sum + (Number(base.codon_span) || 1) * CELL_W, 0)
    : Math.max(bases.length, 1) * CELL_W;

  // A product track with no bases but an exon_skip span means the whole exon is gone,
  // which the engine expects to be stated in words rather than drawn.
  const skipOnly = !bases.length && spans.length > 0 && spans[0].kind === "exon_skip";

  return (
    <div className="mb-1.5">
      {showTitle ? (
        <p className="text-[9px] font-semibold text-emerald-700">{track.title}</p>
      ) : null}
      {skipOnly ? (
        <span className="inline-block rounded border border-dashed border-rose-400 px-3 py-1 text-[10px] text-rose-700">
          {spans[0].label || "exon skipped"}
        </span>
      ) : (
        <div className="whitespace-nowrap leading-none" style={{ width: trackWidth }}>
          {bases.map((base, index) => {
            const ptcSpan = spanAt(index, spans, "ptc");
            // A variant or dup span must win over exon_skip / exon_extension for
            // emphasis, or a variant base sitting inside a spliced-out region loses
            // its red underline to the wider span.
            const emphasis = spanAt(index, spans, "variant") || spanAt(index, spans, "dup");
            const covering = ptcSpan || spanAt(index, spans);
            let kind = base.kind || (codonAligned ? "protein_x" : "intron");
            if (codonAligned && emphasis?.kind === "variant" && track.variant_style !== "underline") {
              kind = "protein_variant";
            } else if (ptcSpan) {
              kind = "ptc";
            } else if (
              covering &&
              (covering.kind === "exon_extension" || covering.kind === "utr_extension") &&
              kind !== "exon"
            ) {
              kind = covering.kind;
            }
            const emph = emphasis || covering;
            const role = base.triplet_role ? ` · ${base.triplet_role} in Gly-X-Y` : "";
            return (
              <BaseCell
                key={index}
                nt={base.nt || "·"}
                kind={kind}
                width={codonAligned ? (Number(base.codon_span) || 1) * CELL_W : CELL_W}
                underline={emph?.kind === "dup" || emph?.kind === "variant"}
                marker={markerAt.get(index) ?? null}
                tooltip={`${base.hgvs ? `${base.hgvs} · ` : ""}${base.nt || ""}${role}`}
              />
            );
          })}
        </div>
      )}
      {annotations.length ? (
        <p className="mt-0.5 text-[8px] text-muted-foreground">{annotations.join(" · ")}</p>
      ) : null}
      {track.summary ? <p className="mt-0.5 text-[9px] text-amber-700">{track.summary}</p> : null}
      {track.dup_seq ? (
        <p className="mt-0.5 text-[8px] text-rose-700">
          Dup insert: <code className="font-mono">{track.dup_seq}</code> ({track.dup_seq.length} nt)
        </p>
      ) : null}
      {track.note ? (
        <p className="mt-0.5 text-[8px] leading-4 text-muted-foreground">{track.note}</p>
      ) : null}
    </div>
  );
}

function isPremrna(track: JunctionTrack): boolean {
  if (track.id === "reference" || track.id === "mutant") return true;
  return track.kind === "premrna";
}

function CollagenBanner({
  stats,
}: {
  stats: NonNullable<JunctionAlignPayload["collagen_gly_xy"]>;
}) {
  const repeats = Number(stats.block_repeat_count) || 0;
  let main = stats.motif_summary || "";
  if (!main) {
    main =
      repeats > 0 && stats.block_aa_lo && stats.block_aa_hi
        ? `${repeats} consecutive Gly-X-Y repeat${repeats === 1 ? "" : "s"} natively (aa ${stats.block_aa_lo}–${stats.block_aa_hi})${stats.meets_nine_rule ? " · meets ≥9 repeat rule" : ""}`
        : "No uninterrupted native Gly-X-Y block at this site";
  }
  if (stats.in_gxg_linker) {
    main = "Gly-X-Gly flexible linker between triple-helical segments";
  }

  // Whether the variant actually replaces a native Gly anchor decides whether the
  // collagen motif argument applies at all, so it is stated rather than implied.
  const role =
    stats.native_register === false
      ? "Not in a native Gly-X-Y block — the variant does not replace a collagen Gly anchor."
      : stats.in_gxg_linker && stats.gxg_linker_note
        ? "Gly-X-Gly flexible linker — no theoretical collagen motif score (PMID 16919298); functional work may still apply."
        : stats.variant_at_gly
          ? "Disrupts a native Gly anchor (Gly slot, reference G)."
          : stats.variant_triplet_role
            ? `Variant at the ${stats.variant_triplet_role} slot — does not replace a native Gly anchor.`
            : null;

  return (
    <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2">
      <p className="text-[10px] leading-4 text-sky-900">
        <span className="font-semibold text-sky-700">Collagen motif:</span> {main}
        {Number(stats.window_repeat_count) > 0
          ? ` · ${stats.window_repeat_count} native Gly-X-Y repeat${Number(stats.window_repeat_count) === 1 ? "" : "s"} in the map window`
          : ""}
        {stats.variant_triplet ? ` · reference triplet ${stats.variant_triplet}` : ""}
        {stats.reference_aa && stats.mutant_aa
          ? ` · reference ${stats.reference_aa} → mutant ${stats.mutant_aa}`
          : ""}
      </p>
      {role ? <p className="mt-1 text-[10px] leading-4 text-sky-800">{role}</p> : null}
    </div>
  );
}

export function JunctionAlign({ payload }: { payload: JunctionAlignPayload }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const tracks = payload.tracks || [];
  const premrna = tracks.filter(isPremrna);
  const products = tracks.filter(track => !isPremrna(track));
  const reference = tracks.find(track => track.id === "reference");
  const gridWidth = Math.max((reference?.bases?.length || 0) * CELL_W, CELL_W);

  // The engine says where the interesting part of a long intron is. Without this a
  // deep intronic map opens on empty intron and looks broken.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const refLength = reference?.bases?.length || 0;
    if (payload.scroll_default === "variant" && payload.variant_base_index !== null && payload.variant_base_index !== undefined) {
      node.scrollLeft = Math.max(0, Number(payload.variant_base_index) * CELL_W - 80);
    } else if (payload.scroll_default === "junction" || payload.deep_map) {
      node.scrollLeft =
        payload.scroll_junction_at === "start"
          ? 0
          : Math.max(0, refLength * CELL_W - node.clientWidth + 40);
    }
  }, [payload, reference]);

  if (payload.eligible === false) return null;

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-700">
          {payload.title || "Junction sequence alignment"}
        </p>
        <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
          {payload.subtitle ||
            `${payload.anchor_hgvs || ""}${payload.downstream_exon ? ` · junction exon ${payload.downstream_exon}` : ""} · mRNA/cDNA sense (T, A, C, G); red underline marks the variant span; Ter is the 3-nt stop when in view.`}
        </p>
      </div>

      {payload.collagen_gly_xy ? <CollagenBanner stats={payload.collagen_gly_xy} /> : null}

      {payload.deep_map ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
          <p className="text-[10px] leading-4 text-amber-900">
            <span className="font-semibold">Deep intronic map</span> —{" "}
            {payload.scroll_hint ||
              `Long intron. Scroll the pre-mRNA rows horizontally; the junction is at the ${
                payload.scroll_junction_at === "start" ? "left" : "right"
              }.`}
          </p>
        </div>
      ) : null}

      {premrna.length ? (
        <div>
          <p className="mb-1 text-[9px] text-muted-foreground">
            Pre-mRNA tracks
            {products.length ? " (reference and mutant scroll together; product rows stay fixed)" : ""}
          </p>
          <div className="flex items-start gap-2">
            <div className="flex shrink-0 flex-col gap-1.5 pt-4" style={{ width: LABEL_WIDTH }}>
              {premrna.map((track, index) => (
                <p
                  key={index}
                  className="text-[9px] font-semibold leading-4 text-emerald-700"
                  style={{ minHeight: 22 }}
                >
                  {track.title}
                </p>
              ))}
            </div>
            <div
              ref={scrollRef}
              className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border/60 px-0.5 py-1"
            >
              <div style={{ width: gridWidth, minWidth: "100%" }}>
                <Ruler payload={payload} width={gridWidth} />
                {premrna.map((track, index) => (
                  <TrackRow key={index} track={track} showTitle={false} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea className="max-w-full">
          <Ruler payload={payload} width={gridWidth} />
        </ScrollArea>
      )}

      {products.length ? (
        <div className="border-t border-border/60 pt-2">
          <p className="mb-1.5 text-[9px] text-muted-foreground">
            Splice products{premrna.length ? " (fixed width — these do not scroll)" : ""}
          </p>
          <div className="overflow-x-auto">
            {products.map((track, index) => (
              // Same label column width as the pre-mRNA block, so a product's first base
              // sits under the reference's first base and the two can be compared.
              <div key={index} className="flex items-start gap-2">
                <p
                  className="shrink-0 text-[9px] font-semibold leading-4 text-amber-700"
                  style={{ width: LABEL_WIDTH }}
                >
                  {track.title}
                </p>
                <div className="min-w-0 flex-1">
                  <TrackRow track={track} showTitle={false} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {payload.legend?.length ? (
        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
          {payload.legend.map((item, index) => (
            <span key={index} className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <span
                className={`inline-block h-2.5 w-3 rounded-sm border ${
                  LEGEND_SWATCH[item.kind || ""] || KIND_CLASS.intron
                }`}
              />
              {item.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Compact header shown when the alignment is collapsed behind a disclosure. */
export function JunctionAlignSummary({ payload }: { payload: JunctionAlignPayload }) {
  const trackCount = (payload.tracks || []).length;
  return (
    <span className="flex items-center gap-2">
      <span className="text-[10px] font-semibold">
        {payload.launcher_label || "Junction sequence map"}
      </span>
      <Badge variant="secondary" className="text-[8px]">
        {trackCount} track{trackCount === 1 ? "" : "s"}
      </Badge>
    </span>
  );
}

import type { PtcMarker, SpliceExon, SpliceFocus, SpliceViz } from "@shared/curation/viz";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type HeadingTone,
  type SpliceRow,
  type SpliceTrack,
  type TrackCell,
  TRACK_HEIGHT,
  buildTrack,
  focusWindow,
  junctionHeading,
  ptcCaption,
  ptcCaptionFromMarker,
  ptcInWindow,
  scaleFor,
  skipHeading,
} from "./spliceLayout";

/**
 * Splice exon map, ported from the engine's `splice-viz.js`.
 *
 * SVG rather than the original's nested flexbox: the map is a scale drawing (box width
 * is proportional to coding bp, and the same exon must be the same width on the
 * Pre-mRNA and mRNA rows so a reviewer can read one against the other), and SVG gives
 * that a single coordinate system. Geometry lives in `spliceLayout.ts`; this file only
 * paints.
 *
 * Every row shows two tracks. **Pre-mRNA** is the gene with introns intact, **mRNA** is
 * the spliced product. Comparing them is the whole point: the exon that vanishes
 * between the rows is the one the variant removes.
 */

const TONE_TEXT: Record<HeadingTone, string> = {
  loss: "text-rose-600",
  gain: "text-emerald-600",
  alt: "text-amber-600",
  reference: "text-sky-600",
  ptc: "text-rose-600",
  muted: "text-muted-foreground",
};

/** Diagonal hatch marks an exon that is absent from the mature transcript. */
function Defs() {
  return (
    <defs>
      <pattern id="sm-skip" width="8" height="8" patternTransform="rotate(135)" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" className="fill-rose-50" />
        <line x1="0" y1="0" x2="0" y2="8" className="stroke-rose-400" strokeWidth="4" />
      </pattern>
      <pattern id="sm-skip-alt" width="8" height="8" patternTransform="rotate(135)" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" className="fill-amber-50" />
        <line x1="0" y1="0" x2="0" y2="8" className="stroke-amber-400" strokeWidth="4" />
      </pattern>
      <pattern id="sm-hidden" width="6" height="6" patternTransform="rotate(135)" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" className="fill-muted" />
        <line x1="0" y1="0" x2="0" y2="6" className="stroke-muted-foreground/40" strokeWidth="2" />
      </pattern>
    </defs>
  );
}

const EXON_FILL: Record<string, string> = {
  normal: "fill-blue-100 stroke-blue-400",
  skipped: "stroke-rose-500",
  skipped_alt: "stroke-amber-500",
  anchor: "fill-emerald-100 stroke-emerald-500",
  utr: "fill-sky-50 stroke-sky-400",
  dimmed: "fill-slate-100 stroke-slate-300",
  faded: "fill-blue-50 stroke-blue-200",
};

function ExonBox({ cell, y }: { cell: Extract<TrackCell, { kind: "exon" }>; y: number }) {
  const { x, width, rank, state, lenBp } = cell;
  const striped = state === "skipped" || state === "skipped_alt";
  const title =
    state === "skipped"
      ? `Exon ${rank} — removed by whole-exon skip in this product`
      : state === "skipped_alt"
        ? `Exon ${rank} — removed by the alternate skip`
        : state === "utr"
          ? `Exon ${rank} — 5′ UTR (non-coding)`
          : state === "anchor"
            ? `Anchor exon ${rank} (gained junction)`
            : state === "faded"
              ? `Exon ${rank} — downstream of the premature stop, not translated`
              : `Exon ${rank}${lenBp ? ` — ${lenBp} coding bp` : ""}`;

  const cut = cell.internalCut;
  const cutX = cut ? x + width * cut.fraction : null;

  return (
    <g opacity={state === "faded" ? 0.4 : 1}>
      <title>{title}</title>
      <rect
        x={x + 1}
        y={y}
        width={Math.max(1, width - 2)}
        height={TRACK_HEIGHT}
        rx={3}
        fill={striped ? `url(#${state === "skipped" ? "sm-skip" : "sm-skip-alt"})` : undefined}
        className={striped ? EXON_FILL[state] : EXON_FILL[state] || EXON_FILL.normal}
        strokeWidth={1}
        strokeDasharray={striped ? "4 3" : undefined}
      />

      {/* Cryptic site inside the exon: amber tick on every track; red hatch only
          on the spliced product, because Pre-mRNA still contains the whole exon. */}
      {cut && cutX !== null ? (
        <>
          {cut.shadeExcised ? (
            <rect
              x={cut.side === "donor" ? cutX : x + 1}
              y={y}
              width={Math.max(1, cut.side === "donor" ? x + width - 1 - cutX : cutX - x - 1)}
              height={TRACK_HEIGHT}
              fill="url(#sm-skip)"
              className="stroke-none"
              opacity={0.85}
            >
              <title>
                {`Spliced out of the mature mRNA by the cryptic ${cut.side === "donor" ? "donor (GT)" : "acceptor (AG)"} inside exon ${rank}`}
              </title>
            </rect>
          ) : null}
          <line
            x1={cutX}
            x2={cutX}
            y1={y - 2}
            y2={y + TRACK_HEIGHT + 2}
            className="stroke-amber-500"
            strokeWidth={1.5}
            strokeDasharray="3 2"
          >
            <title>
              {`Cryptic ${cut.side === "donor" ? "donor (GT)" : "acceptor (AG)"} inside exon ${rank}${cut.shadeExcised ? "" : " — Pre-mRNA still has the full exon"}`}
            </title>
          </line>
        </>
      ) : null}

      {/* Variant locus. */}
      {cell.variantFraction !== null ? (
        <g>
          <title>{`Variant position within exon ${rank}`}</title>
          <line
            x1={x + width * cell.variantFraction}
            x2={x + width * cell.variantFraction}
            y1={y + 2}
            y2={y + TRACK_HEIGHT - 2}
            className="stroke-amber-500"
            strokeWidth={2}
          />
          <path
            d={diamond(x + width * cell.variantFraction, y - 5, 4)}
            className="fill-amber-500"
          />
        </g>
      ) : null}

      {/* Premature stop. */}
      {cell.ptc ? (
        <g>
          <title>{`Premature stop ${cell.ptc.label} — ~${Math.round(cell.ptc.fraction * 100)}% along exon ${rank}`}</title>
          <line
            x1={x + width * cell.ptc.fraction}
            x2={x + width * cell.ptc.fraction}
            y1={y + 3}
            y2={y + TRACK_HEIGHT - 11}
            className="stroke-rose-500"
            strokeWidth={2}
          />
          <text
            x={x + width * cell.ptc.fraction}
            y={y + TRACK_HEIGHT - 2}
            textAnchor="middle"
            className="fill-rose-600 text-[7px] font-bold"
          >
            Ter
          </text>
        </g>
      ) : null}

      {cell.startCodon ? (
        <text x={x + 4} y={y + 8} className="fill-amber-600 text-[6px] font-bold">
          <title>Start codon (AUG) — original Met</title>
          Met
        </text>
      ) : null}

      <text
        x={x + width / 2}
        y={y + TRACK_HEIGHT / 2 + 3}
        textAnchor="middle"
        className="fill-foreground text-[9px] font-semibold"
        style={{ pointerEvents: "none" }}
      >
        E{rank}
      </text>
    </g>
  );
}

function diamond(cx: number, cy: number, r: number) {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

function IntronLine({ cell, y }: { cell: Extract<TrackCell, { kind: "intron" }>; y: number }) {
  const { x, width, leftRank, rightRank, hasVariant, variantEnd } = cell;
  const midY = y + TRACK_HEIGHT / 2;
  // D and A label the anatomical ends of the intron: D is the donor (5′) side after
  // the upstream exon, A the acceptor (3′) side before the downstream one. These are
  // not SpliceAI's DS_DG / DS_AG, which describe predicted mechanism.
  const markX =
    variantEnd === "donor"
      ? x + width * 0.3
      : variantEnd === "acceptor"
        ? x + width * 0.7
        : x + width / 2;
  return (
    <g>
      <title>
        {`Intron between E${leftRank} and E${rightRank}: D marks the donor (5′) side, A the acceptor (3′) side.` +
          (hasVariant ? " The variant lies in this intron." : "")}
      </title>
      <line x1={x + 6} x2={x + width - 6} y1={midY} y2={midY} className="stroke-slate-400" strokeWidth={1.5} />
      <text x={x + 1} y={midY + 3} className="fill-muted-foreground text-[6px] font-bold">
        D
      </text>
      <text x={x + width - 5} y={midY + 3} className="fill-muted-foreground text-[6px] font-bold">
        A
      </text>
      {hasVariant ? <path d={diamond(markX, midY - 7, 4)} className="fill-amber-500" /> : null}
    </g>
  );
}

function PseudoExonBox({
  cell,
  y,
}: {
  cell: Extract<TrackCell, { kind: "pseudoExon" }>;
  y: number;
}) {
  const { x, width, nt, accent, isUtr } = cell;
  const stroke =
    accent === "amber" ? "stroke-amber-500" : isUtr ? "stroke-sky-400" : "stroke-emerald-500";
  const fill = accent === "amber" ? "fill-amber-50" : isUtr ? "fill-sky-50" : "fill-emerald-50";
  return (
    <g>
      <title>
        {isUtr
          ? `${nt ?? "?"} nt 5′ UTR insert (pre-AUG) — annotated ORF unchanged`
          : `${nt ?? "?"} nt pseudo-exon retained in the mature mRNA`}
      </title>
      <rect
        x={x + 2}
        y={y}
        width={Math.max(1, width - 4)}
        height={TRACK_HEIGHT}
        rx={3}
        className={`${fill} ${stroke}`}
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <text
        x={x + width / 2}
        y={y + 13}
        textAnchor="middle"
        className={`text-[8px] font-bold ${accent === "amber" ? "fill-amber-700" : isUtr ? "fill-sky-700" : "fill-emerald-700"}`}
      >
        +{nt ?? "?"} nt
      </text>
      <text
        x={x + width / 2}
        y={y + 23}
        textAnchor="middle"
        className="fill-muted-foreground text-[6px]"
      >
        {isUtr ? "5′ UTR" : "pseudo-exon"}
      </text>
      <text x={x + 4} y={y + TRACK_HEIGHT - 2} className="fill-amber-600 text-[6px] font-bold font-mono">
        {cell.fiveLabel}
      </text>
      <text
        x={x + width - 4}
        y={y + TRACK_HEIGHT - 2}
        textAnchor="end"
        className="fill-orange-600 text-[6px] font-bold font-mono"
      >
        {cell.threeLabel}
      </text>
      {cell.ptc ? (
        <g>
          <title>{`Stop inside the retained segment: ${cell.ptc.label}`}</title>
          <line
            x1={x + width * cell.ptc.fraction}
            x2={x + width * cell.ptc.fraction}
            y1={y + 2}
            y2={y + TRACK_HEIGHT - 10}
            className="stroke-rose-500"
            strokeWidth={2}
          />
          <text
            x={x + width * cell.ptc.fraction}
            y={y + TRACK_HEIGHT - 11}
            textAnchor="middle"
            className="fill-rose-600 text-[6px] font-bold"
          >
            Ter
          </text>
        </g>
      ) : null}
    </g>
  );
}

function EllipsisBlock({
  cell,
  y,
}: {
  cell: Extract<TrackCell, { kind: "ellipsis" }>;
  y: number;
}) {
  const { x, width, count, side } = cell;
  return (
    <g>
      <title>
        {`${count} more exon${count === 1 ? "" : "s"} ${side === "lo" ? "upstream (5′)" : "downstream (3′)"} — hidden in this zoomed row`}
      </title>
      <rect
        x={x + 2}
        y={y + 3}
        width={Math.max(1, width - 4)}
        height={TRACK_HEIGHT - 6}
        rx={2}
        fill="url(#sm-hidden)"
        className="stroke-muted-foreground/40"
        strokeDasharray="3 2"
      />
      <text
        x={x + width / 2}
        y={y + TRACK_HEIGHT / 2 + 3}
        textAnchor="middle"
        className="fill-muted-foreground text-[7px] font-semibold"
      >
        {side === "lo" ? `… +${count}` : `+${count} …`}
      </text>
    </g>
  );
}

function Track({ track, y }: { track: SpliceTrack; y: number }) {
  return (
    <g>
      {track.cells.map((cell, index) => {
        if (cell.kind === "exon") return <ExonBox key={index} cell={cell} y={y} />;
        if (cell.kind === "intron") return <IntronLine key={index} cell={cell} y={y} />;
        if (cell.kind === "pseudoExon") return <PseudoExonBox key={index} cell={cell} y={y} />;
        return <EllipsisBlock key={index} cell={cell} y={y} />;
      })}
    </g>
  );
}

const TRACK_GAP = 6;
const LABEL_WIDTH = 66;

function RowSvg({ row }: { row: SpliceRow }) {
  const width = Math.max(...row.tracks.map(track => track.width), 1);
  const height = row.tracks.length * (TRACK_HEIGHT + TRACK_GAP) + 10;
  return (
    <div className="mt-1.5 overflow-x-auto">
      <svg
        width={LABEL_WIDTH + width}
        height={height}
        role="img"
        aria-label={row.heading.map(part => part.text).join(" ")}
      >
        <Defs />
        {row.tracks.map((track, index) => {
          const y = 8 + index * (TRACK_HEIGHT + TRACK_GAP);
          return (
            <g key={track.role + index}>
              <text
                x={0}
                y={y + TRACK_HEIGHT / 2 + 3}
                className="fill-muted-foreground text-[8px] font-semibold"
              >
                {track.label}
              </text>
              <g transform={`translate(${LABEL_WIDTH}, 0)`}>
                <Track track={track} y={y} />
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Row({ row }: { row: SpliceRow }) {
  return (
    <div className="border-t border-border/50 py-2.5 first:border-0 first:pt-0">
      <p className="text-[10px] font-semibold">
        {row.heading.map((part, index) => (
          <span key={index} className={`${TONE_TEXT[part.tone]} ${index ? "font-medium" : ""}`}>
            {/* A real space, not a margin: this text is also read out by a screen
                reader, which ignores CSS and would run the segments together. */}
            {index ? " " : ""}
            {part.text}
          </span>
        ))}
      </p>
      <RowSvg row={row} />
      {row.ptcCaption ? (
        <p className="mt-1 pl-0.5 text-[9px] leading-4 text-rose-700">{row.ptcCaption}</p>
      ) : null}
    </div>
  );
}

/**
 * Width the tracks aim to fill, measured from the panel.
 *
 * The map lives in the Workbench's right-hand pane, which is narrower than a full page,
 * so a fixed canvas would force a scrollbar on every variant. Exons still refuse to
 * shrink past `EXON_MIN_WIDTH`, so a long window scrolls -- but the common case fits.
 */
function useCanvasWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Fall back to a sensible canvas until the first measurement lands, and in jsdom
  // where ResizeObserver never fires.
  return [ref, Math.max(280, (width || 620) - LABEL_WIDTH)] as const;
}

function focusOf(focus: SpliceFocus | null | undefined, fallback: SpliceExon[]) {
  const exons = focus?.exons?.length ? focus.exons : fallback;
  return {
    exons: exons || [],
    truncBefore: focus?.trunc_before ?? 0,
    truncAfter: focus?.trunc_after ?? 0,
  };
}

export function SpliceMap({ spliceViz }: { spliceViz: SpliceViz }) {
  const [measureRef, canvasWidth] = useCanvasWidth();
  const rows = useMemo(() => buildRows(spliceViz, canvasWidth), [spliceViz, canvasWidth]);

  if (spliceViz.eligible === false) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-6 text-center text-[10px] text-muted-foreground">
        Transcript exon map: {spliceViz.reason || "unavailable"}
      </p>
    );
  }
  if (!rows.length) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-6 text-center text-[10px] text-muted-foreground">
        The engine resolved no exon structure for this variant.
      </p>
    );
  }

  const referenceOnly = spliceViz.reference_only === true;

  return (
    <div ref={measureRef} className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-700">
          {referenceOnly ? "Transcript exon map" : "Splice exon map"}
        </p>
        {spliceViz.hgvs_c_for_viz ? (
          <span className="font-mono text-[9px] text-muted-foreground">
            {spliceViz.hgvs_c_for_viz}
          </span>
        ) : null}
      </div>
      {rows.map(row => (
        <Row key={row.id} row={row} />
      ))}
      <SpliceMapLegend spliceViz={spliceViz} />
    </div>
  );
}

/**
 * Turn the engine payload into drawable rows.
 *
 * Row order is the engine's call (`row_order`): whether the gained junction or the
 * whole-exon skip is listed first reflects which product SpliceAI favours, and
 * reordering them here would misrepresent the prediction.
 */
function buildRows(sv: SpliceViz, available: number): SpliceRow[] {
  const exonsFull = sv.exons_full?.length ? sv.exons_full : sv.exons || [];
  const primary = focusOf(sv.focus_primary, exonsFull);
  const junction = focusOf(sv.focus_junction, primary.exons);
  const secondary = sv.focus_secondary ? focusOf(sv.focus_secondary, exonsFull) : null;
  const target = sv.target_rank ?? null;
  const secTarget = sv.secondary_target_rank ?? null;
  const markers = sv.ptc_markers || null;
  const variantEnd: "donor" | "acceptor" | "unknown" =
    sv.is_donor && !sv.is_acceptor ? "donor" : sv.is_acceptor && !sv.is_donor ? "acceptor" : "unknown";

  const cutSide: "donor" | "acceptor" | null =
    sv.exon_internal_cut_side === "donor"
      ? "donor"
      : sv.exon_internal_cut_side === "acceptor"
        ? "acceptor"
        : null;
  const cutRank = sv.exon_internal_cut_rank;
  const cutFraction = sv.exon_internal_cut_fraction;
  const internalCut =
    cutSide !== null && cutRank !== null && cutRank !== undefined && cutFraction !== null && cutFraction !== undefined
      ? { rank: Number(cutRank), fraction: Number(cutFraction), side: cutSide }
      : null;

  const shared = { variantMarker: sv.variant_marker || null, internalCut, variantEnd };
  const rows: SpliceRow[] = [];

  // ── Reference ────────────────────────────────────────────────────────────────
  const refPtc = markers?.reference || null;
  const refExons =
    target !== null && primary.exons.length ? primary : { exons: exonsFull, truncBefore: 0, truncAfter: 0 };
  const geneOptions = {
    ...shared,
    exons: refExons.exons,
    truncBefore: refExons.truncBefore,
    truncAfter: refExons.truncAfter,
    spliced: false,
    skipRank: null,
    skipAltRank: null,
    anchorRank: null,
    utrRank: sv.pre_atg_utr_pseudoexon === true ? 1 : null,
    startCodonRank: sv.start_codon_exon_rank ?? null,
    fadeAfterRank: null,
    dimNonAnchor: false,
    ptc: null,
    pseudo: null,
  };
  const referenceScale = scaleFor(geneOptions, available);
  const referenceTracks: SpliceTrack[] = [
    buildTrack("gene", "Gene", geneOptions, referenceScale),
  ];
  // A mutant-mRNA row only makes sense once a stop has been resolved on the reference.
  if (refPtc) {
    referenceTracks.push(
      buildTrack(
        "mrna",
        "Mutant mRNA",
        {
          ...geneOptions,
          spliced: true,
          utrRank: null,
          startCodonRank: null,
          fadeAfterRank: refPtc.exon_rank ?? null,
          ptc: refPtc,
        },
        referenceScale
      )
    );
  }
  rows.push({
    id: "reference",
    heading: [
      { text: "Reference", tone: "reference" },
      ...(target !== null
        ? [{ text: `(zoomed ±2 exons around E${target})`, tone: "muted" as HeadingTone }]
        : []),
    ],
    tracks: referenceTracks,
    ptcCaption:
      ptcCaption(
        sv.ptc_location_kind,
        sv.ptc_location_label,
        sv.ptc_location_detail,
        refPtc?.hgvs_p
      ) || ptcCaptionFromMarker(refPtc),
  });

  if (sv.reference_only === true) return rows;

  // ── Whole-exon skip ──────────────────────────────────────────────────────────
  const skipPtc = markers?.skip || null;
  const skipRow: SpliceRow | null =
    sv.suppress_whole_exon_skip_row === true || target === null
      ? null
      : {
          id: "skip",
          heading: skipHeading(sv),
          tracks: dualTrack({
            ...shared,
            exons: primary.exons,
            truncBefore: primary.truncBefore,
            truncAfter: primary.truncAfter,
            skipRank: target,
            ptc: skipPtc,
          }, available),
          ptcCaption:
            ptcCaption(
              sv.skip_ptc_location_kind,
              sv.skip_ptc_location_label,
              sv.skip_ptc_location_detail,
              skipPtc?.hgvs_p
            ) || ptcCaptionFromMarker(skipPtc),
        };

  // ── Secondary skip ───────────────────────────────────────────────────────────
  const secPtc = markers?.secondary_skip || null;
  const secRow: SpliceRow | null =
    secTarget !== null && secondary?.exons.length
      ? {
          id: "skip-alt",
          heading: [
            {
              text: sv.deep_intronic_products
                ? `2. Alternate splice product — E${secTarget} removed (donor loss)`
                : `Secondary whole-exon skip — E${secTarget} removed`,
              tone: "alt",
            },
            ...(sv.secondary_in_frame_skip === true
              ? [
                  {
                    text: "(multiple of 3; in-frame deletion — no novel stop from the skip alone)",
                    tone: "muted" as HeadingTone,
                  },
                ]
              : []),
          ],
          tracks: dualTrack({
            ...shared,
            exons: secondary.exons,
            truncBefore: secondary.truncBefore,
            truncAfter: secondary.truncAfter,
            skipAltRank: secTarget,
            ptc: secPtc,
          }, available),
          ptcCaption:
            ptcCaptionFromMarker(secPtc) ||
            ptcCaption(
              sv.secondary_skip_ptc_location_kind,
              sv.secondary_skip_ptc_location_label,
              sv.secondary_skip_ptc_location_detail,
              secPtc?.hgvs_p
            ),
        }
      : null;

  // ── Gained junction ──────────────────────────────────────────────────────────
  const isUtrInsert = sv.pre_atg_utr_pseudoexon === true;
  const junctionPtc = markers?.junction || null;
  const retained = sv.pseudoexon_retained_nt ?? (sv.shift_nt && sv.shift_nt > 0 ? sv.shift_nt : null);
  const pseudoAnchor =
    sv.pseudo_after_rank ?? (retained !== null && sv.junction_row ? (sv.anchor_exon_rank ?? target) : null);
  const junctionRow: SpliceRow | null = sv.junction_row
    ? {
        id: "junction",
        heading: junctionHeading(sv),
        tracks: dualTrack({
          ...shared,
          exons: junction.exons,
          truncBefore: junction.truncBefore,
          truncAfter: junction.truncAfter,
          anchorRank: target,
          dimNonAnchor: true,
          ptc: sv.ptc_location_kind === "pseudo_exon" ? null : junctionPtc,
          pseudo:
            pseudoAnchor !== null && retained !== null
              ? {
                  afterRank: Number(pseudoAnchor),
                  nt: retained,
                  accent: isUtrInsert ? ("sky" as const) : ("green" as const),
                  fiveLabel:
                    sv.donor_offset_1based !== null && sv.donor_offset_1based !== undefined
                      ? `GT(+${sv.donor_offset_1based})`
                      : "GT",
                  threeLabel:
                    sv.acceptor_offset_1based !== null && sv.acceptor_offset_1based !== undefined
                      ? `AG(+${sv.acceptor_offset_1based})`
                      : "AG",
                  isUtr: isUtrInsert,
                  ptcFraction: isUtrInsert ? null : (sv.pseudoexon_ptc_frac_in_insert ?? null),
                  ptcLabel: isUtrInsert ? null : (sv.pseudoexon_ptc_hgvs ?? null),
                }
              : null,
        }, available),
        ptcCaption: isUtrInsert
          ? null
          : ptcCaption(
              sv.junction_ptc_location_kind,
              sv.junction_ptc_location_label,
              sv.junction_ptc_location_detail,
              sv.pseudoexon_ptc_hgvs
            ) ||
            ptcCaption(
              sv.ptc_location_kind,
              sv.ptc_location_label,
              sv.ptc_location_detail,
              sv.pseudoexon_ptc_hgvs
            ) ||
            ptcCaptionFromMarker(junctionPtc),
      }
    : null;

  const ordered =
    sv.row_order === "ref_junction_skip" && junctionRow
      ? [junctionRow, skipRow, secRow]
      : [skipRow, secRow, junctionRow];
  for (const row of ordered) if (row) rows.push(row);

  // A stop outside every on-screen window gets its own zoomed row, otherwise the Ter
  // tick is simply missing and the reviewer has no idea where the stop is.
  for (const [marker, label, visible] of [
    [markers?.skip ?? null, "after whole-exon skip", primary.exons],
    [markers?.junction ?? null, "cryptic splice product", junction.exons],
    [markers?.secondary_skip ?? null, "after secondary skip", secondary?.exons ?? []],
  ] as [PtcMarker | null, string, SpliceExon[]][]) {
    if (!marker || marker.exon_rank === null || marker.exon_rank === undefined) continue;
    if (ptcInWindow(visible, marker)) continue;
    const rank = Number(marker.exon_rank);
    const window = focusWindow(exonsFull, rank, 2);
    if (!window.exons.length) continue;
    rows.push({
      id: `ptc-${label}-${rank}`,
      heading: [
        { text: "Novel stop (PTC)", tone: "ptc" },
        { text: `— ${label} (zoomed ±2 exons around E${rank})`, tone: "muted" },
      ],
      tracks: dualTrack({
        ...shared,
        exons: window.exons,
        truncBefore: window.truncBefore,
        truncAfter: window.truncAfter,
        ptc: marker,
        fadeAfterRank: rank,
      }, available),
      ptcCaption: ptcCaptionFromMarker(marker),
    });
  }

  return rows;
}

type DualTrackArgs = Omit<
  Parameters<typeof buildTrack>[2],
  "spliced" | "skipRank" | "skipAltRank" | "anchorRank" | "utrRank" | "startCodonRank" | "fadeAfterRank" | "dimNonAnchor" | "pseudo"
> &
  Partial<
    Pick<
      Parameters<typeof buildTrack>[2],
      "skipRank" | "skipAltRank" | "anchorRank" | "utrRank" | "startCodonRank" | "fadeAfterRank" | "dimNonAnchor" | "pseudo"
    >
  >;

/**
 * Pre-mRNA above, spliced mRNA below — the pairing the reviewer compares.
 *
 * Both tracks are drawn at the scale that fits the Pre-mRNA row, so an exon keeps its
 * width when it survives splicing and the exon that disappears is the one that was
 * removed.
 */
function dualTrack(args: DualTrackArgs, available: number): SpliceTrack[] {
  const base = {
    skipRank: null,
    skipAltRank: null,
    anchorRank: null,
    utrRank: null,
    startCodonRank: null,
    fadeAfterRank: null,
    dimNonAnchor: false,
    pseudo: null,
    ...args,
  };
  const unspliced = { ...base, spliced: false };
  const scale = scaleFor(unspliced, available);
  return [
    buildTrack("pre-mrna", "Pre-mRNA", unspliced, scale),
    buildTrack("mrna", "mRNA", { ...base, spliced: true }, scale),
  ];
}

function SpliceMapLegend({ spliceViz }: { spliceViz: SpliceViz }) {
  const hasCut = spliceViz.exon_internal_cut_rank !== null && spliceViz.exon_internal_cut_rank !== undefined;
  return (
    <details className="mt-2 border-t border-border/60 pt-2">
      <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        How to read this map
      </summary>
      <div className="mt-2 space-y-1.5 text-[9px] leading-4 text-muted-foreground">
        <p>
          Exon box width is proportional to coding bp, and the same exon keeps its width on
          the Pre-mRNA and mRNA rows so the two can be read against each other. Scroll
          horizontally when a row overflows.
        </p>
        <p>
          <span className="font-semibold text-amber-600">◆</span> marks the variant locus
          (schematic, from HGVS c.). A <span className="font-semibold text-rose-600">striped exon</span>{" "}
          is absent from that product&apos;s mRNA. A{" "}
          <span className="font-semibold text-emerald-600">dashed green box</span> is an intronic
          pseudo-exon retained between the labelled GT/AG sites.
        </p>
        <p>
          <span className="font-semibold text-rose-600">Ter</span> is a premature stop in the
          translated ORF. On an exon box it falls in native coding sequence; on a dashed
          pseudo-exon it falls inside the retained intronic segment. Each row spells this out
          under &quot;PTC location&quot;.
        </p>
        {hasCut ? (
          <p>
            The <span className="font-semibold text-amber-600">dashed amber line</span> inside an
            exon marks a cryptic{" "}
            {spliceViz.exon_internal_cut_side === "donor" ? "donor (GT)" : "acceptor (AG)"}; the
            striped half on the other side is spliced out of the mature mRNA.
          </p>
        ) : null}
        <p>
          D and A on an intron label its donor (5′) and acceptor (3′) ends. They are anatomy,
          not SpliceAI&apos;s DS_DG / DS_AG mechanism scores.
        </p>
      </div>
    </details>
  );
}

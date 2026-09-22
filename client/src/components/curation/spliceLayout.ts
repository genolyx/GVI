import type { PtcMarker, SpliceExon, SpliceViz, VariantMarker } from "@shared/curation/viz";

/**
 * Geometry for the splice exon map.
 *
 * Kept separate from the SVG so the arithmetic that decides what a reviewer sees --
 * which exon is striped, where the Ter tick lands, how wide a pseudo-exon is -- can be
 * tested without a DOM. The original engine renderer did this with nested flexbox in
 * HTML strings; SVG has no flexbox, so widths are solved here explicitly.
 */

export const EXON_MIN_WIDTH = 46;
export const INTRON_WIDTH = 30;
export const ELLIPSIS_WIDTH = 46;
export const TRACK_HEIGHT = 34;

/** How an exon box is shaded, which is the map's primary signal. */
export type ExonState =
  /** Present and unremarkable. */
  | "normal"
  /** Removed by whole-exon skip in this product. */
  | "skipped"
  /** Removed by the secondary/alternate skip. */
  | "skipped_alt"
  /** The exon the gained junction anchors to. */
  | "anchor"
  /** 5' UTR, non-coding. */
  | "utr"
  /** Present but not the subject of this row. */
  | "dimmed"
  /** Downstream of a premature stop, so not translated. */
  | "faded";

export type TrackCell =
  | {
      kind: "ellipsis";
      /** How many exons are hidden on this side. */
      count: number;
      side: "lo" | "hi";
      x: number;
      width: number;
    }
  | {
      kind: "exon";
      rank: number;
      lenBp: number | null;
      state: ExonState;
      x: number;
      width: number;
      /** Variant tick, as a fraction across the box. */
      variantFraction: number | null;
      /** Premature stop tick, as a fraction across the box. */
      ptc: { fraction: number; label: string } | null;
      /** True when this exon holds the start codon. */
      startCodon: boolean;
      /**
       * A cryptic site inside the exon. The amber tick is drawn on every track;
       * `shadeExcised` is true only on the spliced (mRNA) product, because
       * Pre-mRNA still contains the whole exon.
       */
      internalCut: { fraction: number; side: "donor" | "acceptor"; shadeExcised: boolean } | null;
    }
  | {
      kind: "intron";
      leftRank: number | null;
      rightRank: number;
      x: number;
      width: number;
      hasVariant: boolean;
      /** Which end of the intron the variant sits near, when known. */
      variantEnd: "donor" | "acceptor" | "unknown" | null;
    }
  | {
      kind: "pseudoExon";
      nt: number | null;
      x: number;
      width: number;
      /** Sky-tinted for a 5' UTR insert, amber for the alternate model. */
      accent: "green" | "amber" | "sky";
      /** A stop inside the retained segment. */
      ptc: { fraction: number; label: string } | null;
      fiveLabel: string;
      threeLabel: string;
      isUtr: boolean;
    };

export type SpliceTrack = {
  /** "Pre-mRNA" keeps introns; "mRNA" is the spliced product. */
  role: "pre-mrna" | "mrna" | "gene";
  label: string;
  cells: TrackCell[];
  width: number;
};

export type SpliceRow = {
  id: string;
  /** Heading segments, so the SVG can colour them without parsing HTML. */
  heading: { text: string; tone: HeadingTone }[];
  tracks: SpliceTrack[];
  /** "PTC location: ..." caption under the row, when a stop is predicted. */
  ptcCaption: string | null;
};

export type HeadingTone = "loss" | "gain" | "alt" | "reference" | "muted" | "ptc";

type BuildCellsOptions = {
  exons: SpliceExon[];
  truncBefore: number;
  truncAfter: number;
  /** mRNA tracks drop the skipped exon and the introns entirely. */
  spliced: boolean;
  skipRank: number | null;
  skipAltRank: number | null;
  anchorRank: number | null;
  utrRank: number | null;
  startCodonRank: number | null;
  fadeAfterRank: number | null;
  dimNonAnchor: boolean;
  variantMarker: VariantMarker | null;
  ptc: PtcMarker | null;
  pseudo: {
    afterRank: number;
    nt: number | null;
    accent: "green" | "amber" | "sky";
    fiveLabel: string;
    threeLabel: string;
    isUtr: boolean;
    ptcFraction: number | null;
    ptcLabel: string | null;
  } | null;
  internalCut: { rank: number; fraction: number; side: "donor" | "acceptor" } | null;
  /** Which end of the intron holds the variant, from is_donor / is_acceptor. */
  variantEnd: "donor" | "acceptor" | "unknown";
};

/** Pseudo-exon boxes scale with retained length but stay legible and bounded. */
export function pseudoExonWidth(nt: number | null): number {
  if (nt === null || !Number.isFinite(nt) || nt <= 0) return 96;
  return Math.max(96, Math.min(300, Math.round(nt * 0.85)));
}

/** Clamp a tick fraction so it never renders flush against a box edge. */
function clampFraction(value: number | null | undefined, fallback = 0.5): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(0.97, Math.max(0.03, value));
}

function exonWeight(exon: SpliceExon, count: number): number {
  const len = exon.len_bp;
  if (len !== null && len !== undefined && Number.isFinite(len) && len > 0) return len;
  // No length recorded: fall back to an even share so the row still reads.
  return Math.max(40, Math.round(400 / Math.max(1, count)));
}

type WidthSpec = { fixed?: number; weight?: number };

/**
 * Pixels per coding bp that makes `cells` fill `available`.
 *
 * Returned separately from `solveWidths` so every track in a row can share one scale.
 * That is what lets a reviewer read the mRNA row against the Pre-mRNA row above it: if
 * the spliced track were scaled to its own contents, dropping an exon would *widen* the
 * survivors and the removal would read as a layout change rather than a deletion.
 */
export function deriveScale(cells: WidthSpec[], available: number): number {
  const fixedTotal = cells.reduce((sum, cell) => sum + (cell.fixed ?? 0), 0);
  const weightTotal = cells
    .filter(cell => cell.fixed === undefined)
    .reduce((sum, cell) => sum + (cell.weight ?? 1), 0);
  if (!weightTotal) return 1;
  return Math.max(0, available - fixedTotal) / weightTotal;
}

/**
 * Solve widths at a given scale.
 *
 * Fixed-width cells (introns, ellipses, pseudo-exons) keep their size; exons take
 * `weight * scale`, never below `EXON_MIN_WIDTH`. When the minimums do not fit, the
 * track overflows and the caller scrolls -- shrinking an exon below ~46px hides its rank
 * label, which is worse than a scrollbar.
 */
export function solveWidths(cells: WidthSpec[], scale: number): number[] {
  return cells.map(cell =>
    cell.fixed !== undefined
      ? cell.fixed
      : Math.max(EXON_MIN_WIDTH, Math.round((cell.weight ?? 1) * scale))
  );
}

function exonState(rank: number, options: BuildCellsOptions): ExonState {
  if (options.utrRank !== null && rank === options.utrRank) return "utr";
  if (options.skipRank !== null && rank === options.skipRank) return "skipped";
  if (options.skipAltRank !== null && rank === options.skipAltRank) return "skipped_alt";
  if (options.anchorRank !== null && rank === options.anchorRank) return "anchor";
  if (options.fadeAfterRank !== null && rank > options.fadeAfterRank) return "faded";
  if (options.dimNonAnchor) return "dimmed";
  return "normal";
}

type CellSpec = WidthSpec & { make: (x: number, width: number) => TrackCell };

/** Cells for one track, before widths are resolved. */
function trackSpecs(options: BuildCellsOptions): CellSpec[] {
  const exons = (options.exons || []).filter(
    exon => exon.rank !== null && exon.rank !== undefined
  );
  const vm = options.variantMarker;
  const removedRank = options.spliced
    ? (options.skipAltRank ?? options.skipRank ?? null)
    : null;

  const specs: CellSpec[] = [];

  if (options.truncBefore > 0) {
    const count = options.truncBefore;
    specs.push({
      fixed: ELLIPSIS_WIDTH,
      make: (x, width) => ({ kind: "ellipsis", count, side: "lo", x, width }),
    });
  }

  const visible = exons.filter(exon => Number(exon.rank) !== removedRank);

  visible.forEach((exon, index) => {
    const rank = Number(exon.rank);
    const showVariantTick = vm?.mode === "exon" && Number(vm.exon_rank) === rank;
    const ptcHere =
      options.spliced && options.ptc && Number(options.ptc.exon_rank) === rank
        ? {
            fraction: clampFraction(options.ptc.fraction_in_exon),
            label: options.ptc.hgvs_p || "Ter",
          }
        : null;
    const cut =
      options.internalCut && options.internalCut.rank === rank ? options.internalCut : null;

    specs.push({
      weight: exonWeight(exon, visible.length),
      make: (x, width) => ({
        kind: "exon",
        rank,
        lenBp: exon.len_bp ?? null,
        state: exonState(rank, options),
        x,
        width,
        variantFraction: showVariantTick ? clampFraction(vm?.fraction_in_exon) : null,
        ptc: ptcHere,
        startCodon: options.startCodonRank !== null && rank === options.startCodonRank,
        internalCut: cut
          ? {
              fraction: clampFraction(cut.fraction),
              side: cut.side,
              // Pre-mRNA still has the full exon; only the mature product loses a half.
              shadeExcised: options.spliced,
            }
          : null,
      }),
    });

    // The pseudo-exon is a retained intronic segment, so on the spliced product it
    // sits between its anchor exon and the next one.
    const pseudo = options.pseudo;
    if (options.spliced && pseudo && pseudo.afterRank === rank) {
      specs.push({
        fixed: pseudoExonWidth(pseudo.nt),
        make: (x, width) => ({
          kind: "pseudoExon",
          nt: pseudo.nt,
          x,
          width,
          accent: pseudo.accent,
          ptc:
            pseudo.ptcLabel !== null || pseudo.ptcFraction !== null
              ? {
                  fraction: clampFraction(pseudo.ptcFraction),
                  label: pseudo.ptcLabel || "Ter",
                }
              : null,
          fiveLabel: pseudo.fiveLabel,
          threeLabel: pseudo.threeLabel,
          isUtr: pseudo.isUtr,
        }),
      });
    }

    if (!options.spliced && index < visible.length - 1) {
      const nextRank = Number(visible[index + 1].rank);
      const hasVariant =
        vm?.mode === "intron" &&
        Number(vm.upstream_exon) === rank &&
        Number(vm.downstream_exon) === nextRank;
      specs.push({
        fixed: INTRON_WIDTH,
        make: (x, width) => ({
          kind: "intron",
          leftRank: rank,
          rightRank: nextRank,
          x,
          width,
          hasVariant,
          variantEnd: hasVariant ? options.variantEnd : null,
        }),
      });
    }
  });

  if (options.truncAfter > 0) {
    const count = options.truncAfter;
    specs.push({
      fixed: ELLIPSIS_WIDTH,
      make: (x, width) => ({ kind: "ellipsis", count, side: "hi", x, width }),
    });
  }

  return specs;
}

/**
 * Build one Pre-mRNA or mRNA track at a given px-per-bp scale.
 *
 * Pass the same `scale` to every track in a row; `scaleFor` derives it from whichever
 * track carries the most content.
 */
export function buildTrack(
  role: SpliceTrack["role"],
  label: string,
  options: BuildCellsOptions,
  scale: number
): SpliceTrack {
  const specs = trackSpecs(options);
  const widths = solveWidths(specs, scale);
  let cursor = 0;
  const cells = specs.map((spec, index) => {
    const cell = spec.make(cursor, widths[index]);
    cursor += widths[index];
    return cell;
  });
  return { role, label, cells, width: cursor };
}

/** The scale at which `options` fills `available` px. */
export function scaleFor(options: BuildCellsOptions, available: number): number {
  return deriveScale(trackSpecs(options), available);
}

/** Whether a stop falls inside the exons currently on screen. */
export function ptcInWindow(exons: SpliceExon[] | null | undefined, ptc: PtcMarker | null) {
  if (!ptc || ptc.exon_rank === null || ptc.exon_rank === undefined) return false;
  return (exons || []).some(exon => Number(exon.rank) === Number(ptc.exon_rank));
}

/** A ±`neighbour` exon window around `centerRank`, for the zoomed PTC row. */
export function focusWindow(
  exonsFull: SpliceExon[] | null | undefined,
  centerRank: number,
  neighbour = 2
): { exons: SpliceExon[]; truncBefore: number; truncAfter: number } {
  const all = (exonsFull || []).filter(e => e.rank !== null && e.rank !== undefined);
  if (!all.length || !Number.isFinite(centerRank)) {
    return { exons: [], truncBefore: 0, truncAfter: 0 };
  }
  const ranks = all.map(e => Number(e.rank));
  const lo = Math.max(Math.min(...ranks), centerRank - neighbour);
  const hi = Math.min(Math.max(...ranks), centerRank + neighbour);
  const exons = all
    .filter(e => Number(e.rank) >= lo && Number(e.rank) <= hi)
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  return {
    exons,
    truncBefore: all.filter(e => Number(e.rank) < lo).length,
    truncAfter: all.filter(e => Number(e.rank) > hi).length,
  };
}

/**
 * Heading for the whole-exon-skip row.
 *
 * The engine distinguishes a skip that SpliceAI ranks first from one that merely runs
 * in parallel with a gained junction, and a reviewer needs that distinction to weigh
 * PVS1. The wording mirrors the engine's own renderer.
 */
export function skipHeading(sv: SpliceViz): { text: string; tone: HeadingTone }[] {
  const target = sv.target_rank ?? null;
  const exon = `E${target ?? "?"}`;
  const lossFirst =
    sv.spliceai_loss_delta_exceeds_gain === true && sv.spliceai_gain_delta_exceeds_loss !== true;
  const gainFirst =
    sv.spliceai_gain_delta_exceeds_loss === true && sv.spliceai_loss_delta_exceeds_gain !== true;

  if (sv.exon_skip_spliceai_primary === true && !sv.competing && sv.junction_is_primary !== true) {
    return [
      { text: "Whole-exon skip (loss primary)", tone: "loss" },
      { text: `— ${exon} removed`, tone: "muted" },
    ];
  }
  if (sv.competing && lossFirst) {
    return [
      { text: "Preferred loss:", tone: "loss" },
      { text: `whole-exon skip — ${exon} removed`, tone: "muted" },
    ];
  }
  if (sv.competing && gainFirst) {
    return [
      { text: "Parallel whole-exon skip", tone: "loss" },
      { text: "(loss product)", tone: "muted" },
      { text: `— ${exon} removed`, tone: "muted" },
    ];
  }
  if (sv.competing) {
    return [
      { text: "Whole-exon skip", tone: "loss" },
      { text: `(loss product) — ${exon} removed`, tone: "muted" },
    ];
  }
  if (sv.junction_is_primary === true && sv.junction_row === true) {
    return [
      { text: "Parallel whole-exon skip", tone: "loss" },
      { text: "(baseline if canonical site fails)", tone: "muted" },
      { text: `— ${exon} removed`, tone: "muted" },
    ];
  }
  return [
    { text: "Whole-exon skip", tone: "loss" },
    { text: `— ${exon} removed`, tone: "muted" },
  ];
}

/** Heading for the gained-junction row, naming the mechanism SpliceAI resolved. */
export function junctionHeading(sv: SpliceViz): { text: string; tone: HeadingTone }[] {
  const retained = sv.pseudoexon_retained_nt ?? null;
  const ntLabel = retained !== null ? ` — +${retained} nt pseudo-exon retained` : "";

  if (sv.pre_atg_utr_pseudoexon === true && sv.junction_row === true) {
    return [
      { text: "1. Primary splice product", tone: "gain" },
      {
        text: `— donor gain (DS_DG)${retained !== null ? ` (+${retained} nt 5′ UTR, pre-AUG)` : ""}`,
        tone: "reference",
      },
      { text: "ORF unchanged; mRNA/translation effects possible", tone: "muted" },
    ];
  }
  if (sv.deep_intronic_products === true && sv.junction_row === true) {
    const inFrame = sv.in_frame_exonization === true;
    const insert = sv.pseudoexon_insert_nt ?? retained;
    const mech =
      sv.primary_mechanism === "acceptor_gain" ? "acceptor gain (DS_AG)" : "donor gain (DS_DG)";
    return [
      { text: "1. Primary splice product", tone: "gain" },
      {
        text: inFrame
          ? `— exonization${insert !== null ? ` (+${insert} nt pseudo-exon, in-frame)` : " (in-frame pseudo-exon)"}`
          : `— ${mech}${retained !== null ? ` (+${retained} nt pseudo-exon)` : ""}`,
        tone: "gain",
      },
    ];
  }

  const mechName = sv.is_donor ? "Donor-gain (DS_DG)" : sv.is_acceptor ? "Acceptor-gain (DS_AG)" : null;
  if (mechName) {
    if (sv.junction_is_primary === true) {
      return [
        { text: mechName, tone: "gain" },
        { text: `(primary)${ntLabel}`, tone: "gain" },
      ];
    }
    if (sv.competing === true) {
      return [
        { text: mechName, tone: "gain" },
        { text: "(competing)", tone: "alt" },
      ];
    }
    if (sv.spliceai_secondary_gain_product === true) {
      return [
        { text: mechName, tone: "gain" },
        { text: `(secondary)${ntLabel}`, tone: "alt" },
      ];
    }
    return [{ text: mechName, tone: "gain" }];
  }
  if (sv.site === "intronic") {
    return [
      { text: "Intronic context", tone: "gain" },
      { text: "— shifted junction", tone: "muted" },
    ];
  }
  return [{ text: "Shifted junction", tone: "gain" }];
}

/**
 * The "PTC location: ..." caption.
 *
 * Whether the stop lands in a native coding exon or inside a retained pseudo-exon
 * changes how a reviewer reads NMD, so the distinction is spelled out rather than
 * left to the Ter tick's position.
 */
export function ptcCaption(
  kind: string | null | undefined,
  label: string | null | undefined,
  detail: string | null | undefined,
  hgvs: string | null | undefined
): string | null {
  if (!label && !hgvs) return null;
  const where =
    kind === "pseudo_exon"
      ? label || "retained pseudo-exon"
      : kind === "coding_exon"
        ? label || "native coding exon"
        : label || "see protein line above";
  const parts = [`PTC location: ${where}`];
  if (detail) parts.push(`(${detail})`);
  if (hgvs) parts.push(`— ${hgvs}`);
  return `${parts.join(" ")} — Ter marker on map shows position.`;
}

/** Caption derived from a `ptc_markers` entry when no explicit label was emitted. */
export function ptcCaptionFromMarker(ptc: PtcMarker | null): string | null {
  if (!ptc || ptc.exon_rank === null || ptc.exon_rank === undefined) return null;
  const rank = Number(ptc.exon_rank);
  if (!Number.isFinite(rank) || rank < 1) return null;
  const detail =
    ptc.fraction_in_exon !== null && ptc.fraction_in_exon !== undefined
      ? `~${Math.round(Number(ptc.fraction_in_exon) * 100)}% along exon ${rank} box`
      : null;
  return ptcCaption("coding_exon", `native coding exon ${rank}`, detail, ptc.hgvs_p);
}

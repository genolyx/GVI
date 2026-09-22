import { z } from "zod";

/**
 * Shapes for the engine's visualization payloads, read out of the pass-through
 * layer (`engine.parsedData`).
 *
 * These are deliberately **lenient**: every field is optional, unknown keys survive,
 * and scalars coerce rather than reject. The pass-through layer exists so the engine
 * can add facts without a contract change, and that guarantee is worthless if the UI
 * throws on an unrecognised key. A missing field must degrade one glyph, never blank
 * the whole splice map.
 *
 * The contract core in `document.ts` is the opposite — strict and versioned — because
 * server logic branches on it. Nothing here drives ACMG, triage or reports.
 */

/** Accepts numeric strings, since the engine emits some ranks as text. */
const num = z.coerce.number().finite().nullish().catch(null);
const int = z.coerce.number().int().nullish().catch(null);
const str = z.coerce.string().nullish().catch(null);
const bool = z.coerce.boolean().nullish().catch(null);

/** One exon box. `w` is the engine's own width fraction; we re-derive from `len_bp`. */
export const spliceExonSchema = z
  .object({ rank: int, len_bp: int, w: num })
  .passthrough();

/** A zoomed exon window with counts of what was cut off either side. */
export const spliceFocusSchema = z
  .object({
    exons: z.array(spliceExonSchema).nullish().catch(null),
    trunc_before: int,
    trunc_after: int,
    window_lo: int,
    window_hi: int,
  })
  .passthrough();

/** Where the variant sits: inside an exon, or between two of them. */
export const variantMarkerSchema = z
  .object({
    mode: str,
    exon_rank: int,
    fraction_in_exon: num,
    upstream_exon: int,
    downstream_exon: int,
  })
  .passthrough();

/** A predicted premature stop, positioned as a fraction along one exon box. */
export const ptcMarkerSchema = z
  .object({
    exon_rank: int,
    fraction_in_exon: num,
    hgvs_p: str,
    ptc_aa_position: int,
  })
  .passthrough();

export const spliceVizSchema = z
  .object({
    eligible: bool,
    reason: str,
    gene: str,
    hgvs_c_for_viz: str,
    caption: str,

    exons: z.array(spliceExonSchema).nullish().catch(null),
    exons_full: z.array(spliceExonSchema).nullish().catch(null),
    truncated_before: int,
    truncated_after: int,

    focus_primary: spliceFocusSchema.nullish().catch(null),
    focus_junction: spliceFocusSchema.nullish().catch(null),
    focus_secondary: spliceFocusSchema.nullish().catch(null),

    target_rank: int,
    secondary_target_rank: int,
    secondary_mechanism: str,
    anchor_exon_rank: int,
    next_exon_rank: int,
    start_codon_exon_rank: int,

    /** Which product rows to draw and in what order. */
    row_order: str,
    reference_only: bool,
    junction_row: bool,
    suppress_whole_exon_skip_row: bool,

    site: str,
    is_donor: bool,
    is_acceptor: bool,
    primary_mechanism: str,
    competing: bool,
    junction_is_primary: bool,
    exon_skip_spliceai_primary: bool,
    spliceai_loss_delta_exceeds_gain: bool,
    spliceai_gain_delta_exceeds_loss: bool,
    spliceai_secondary_gain_product: bool,

    in_frame_exonization: bool,
    in_frame_skip: bool,
    secondary_in_frame_skip: bool,
    shift_nt: int,

    deep_intronic_products: bool,
    use_exonization_schematic: bool,
    pre_atg_utr_pseudoexon: bool,
    first_mrna_utr: bool,
    pseudo_after_rank: int,
    pseudoexon_retained_nt: int,
    pseudoexon_insert_nt: int,
    pseudoexon_ptc_within_insert: bool,
    pseudoexon_ptc_hgvs: str,
    pseudoexon_ptc_frac_in_insert: num,

    donor_offset_1based: int,
    acceptor_offset_1based: int,
    canonical_gt_offset_1based: int,
    canonical_acceptor_offset_1based: int,
    gt_offset_1based: int,
    intronic_ag_offset_1based: int,
    pseudoexon_model: str,

    /** Cryptic site *inside* an exon: part of the box is spliced out. */
    exon_internal_cut_rank: int,
    exon_internal_cut_fraction: num,
    exon_internal_cut_side: str,

    variant_marker: variantMarkerSchema.nullish().catch(null),
    ptc_markers: z
      .object({
        reference: ptcMarkerSchema.nullish().catch(null),
        skip: ptcMarkerSchema.nullish().catch(null),
        junction: ptcMarkerSchema.nullish().catch(null),
        secondary_skip: ptcMarkerSchema.nullish().catch(null),
      })
      .passthrough()
      .nullish()
      .catch(null),

    ptc_location_kind: str,
    ptc_location_label: str,
    ptc_location_detail: str,
    skip_ptc_location_kind: str,
    skip_ptc_location_label: str,
    skip_ptc_location_detail: str,
    junction_ptc_location_kind: str,
    junction_ptc_location_label: str,
    junction_ptc_location_detail: str,
    secondary_skip_ptc_location_kind: str,
    secondary_skip_ptc_location_label: str,
    secondary_skip_ptc_location_detail: str,
  })
  .passthrough();

export type SpliceViz = z.infer<typeof spliceVizSchema>;
export type SpliceExon = z.infer<typeof spliceExonSchema>;
export type SpliceFocus = z.infer<typeof spliceFocusSchema>;
export type PtcMarker = z.infer<typeof ptcMarkerSchema>;
export type VariantMarker = z.infer<typeof variantMarkerSchema>;

// ── Junction sequence alignment ────────────────────────────────────────────────

/** One nucleotide (or codon, on protein tracks) cell. */
export const junctionBaseSchema = z
  .object({
    nt: str,
    kind: str,
    hgvs: str,
    codon_span: int,
    triplet_role: str,
  })
  .passthrough();

/** A half-open `[start, end)` run of bases sharing a role. */
export const junctionSpanSchema = z
  .object({ start: int, end: int, kind: str, label: str })
  .passthrough();

export const junctionMarkerSchema = z
  .object({ index: int, kind: str, label: str })
  .passthrough();

export const junctionTrackSchema = z
  .object({
    id: str,
    kind: str,
    title: str,
    bases: z.array(junctionBaseSchema).nullish().catch(null),
    spans: z.array(junctionSpanSchema).nullish().catch(null),
    markers: z.array(junctionMarkerSchema).nullish().catch(null),
    codon_aligned: bool,
    variant_style: str,
    summary: str,
    note: str,
    dup_seq: str,
  })
  .passthrough();

export const junctionAlignSchema = z
  .object({
    eligible: bool,
    title: str,
    subtitle: str,
    anchor_hgvs: str,
    upstream_exon: int,
    downstream_exon: int,
    map_type: str,
    deep_map: bool,
    scroll_hint: str,
    scroll_default: str,
    scroll_junction_at: str,
    variant_base_index: int,
    launcher_label: str,
    launcher_hint: str,
    tracks: z.array(junctionTrackSchema).nullish().catch(null),
    ruler: z
      .array(z.object({ index: int, label: str }).passthrough())
      .nullish()
      .catch(null),
    legend: z
      .array(z.object({ kind: str, label: str }).passthrough())
      .nullish()
      .catch(null),
    collagen_gly_xy: z
      .object({
        motif_summary: str,
        block_repeat_count: int,
        window_repeat_count: int,
        block_aa_lo: int,
        block_aa_hi: int,
        meets_nine_rule: bool,
        in_gxg_linker: bool,
        gxg_linker_note: str,
        native_register: bool,
        variant_at_gly: bool,
        variant_triplet: str,
        variant_triplet_role: str,
        reference_aa: str,
        mutant_aa: str,
      })
      .passthrough()
      .nullish()
      .catch(null),
  })
  .passthrough();

export type JunctionAlign = z.infer<typeof junctionAlignSchema>;
export type JunctionTrack = z.infer<typeof junctionTrackSchema>;
export type JunctionBase = z.infer<typeof junctionBaseSchema>;
export type JunctionSpan = z.infer<typeof junctionSpanSchema>;
export type JunctionMarker = z.infer<typeof junctionMarkerSchema>;

// ── Literature ────────────────────────────────────────────────────────────────

export const literatureSchema = z
  .object({
    status: str,
    error: str,
    clinical_summary: str,
    functional_summary: str,
    local_index: z
      .object({
        query: str,
        hit_count: int,
        pmids: z.array(z.coerce.string()).nullish().catch(null),
      })
      .passthrough()
      .nullish()
      .catch(null),
  })
  .passthrough();

export type Literature = z.infer<typeof literatureSchema>;

/**
 * Read one visualization payload out of `engine.parsedData`.
 *
 * Returns null instead of throwing, because a malformed payload should cost the
 * reviewer one panel, not the entire curation tab.
 */
export function readVizPayload<T>(
  parsedData: Record<string, unknown> | null | undefined,
  key: string,
  schema: z.ZodType<T>
): T | null {
  const raw = parsedData?.[key];
  if (!raw || typeof raw !== "object") return null;
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

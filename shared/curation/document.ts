import { z } from "zod";

/**
 * CurationDocument v1 — the contract between the SAM-VC curation engine and the
 * GVI control plane.
 *
 * The document is deliberately split into two layers with opposite trade-offs.
 *
 * `core` (meta / variant / scores / acmg / highlights) is strict and versioned.
 * Server logic reads it: triage thresholds, ACMG merge, report findings and the
 * signature hash chain all depend on these fields, so they must not drift. Adding
 * a field here costs an edit in four places (this schema, `contract.py`, the
 * adapter, the conformance test) and that friction is the point.
 *
 * `engine` is the engine's own output passed through unmodified. Curation is the
 * product's core value and it evolves on the engine's schedule, so describing all
 * ~190 `parsed_data` keys structurally would mean re-typing the engine's fact
 * sheet in two languages and editing the contract for every engine release. The
 * Curation UI reads these keys directly, the same way SAM-VC's own panel does.
 * An engine that adds a fact needs no change here at all.
 *
 * The cost of the pass-through layer is that TypeScript cannot check key names
 * inside it. That is the trade we accept in exchange for cheap engine updates;
 * anything a clinical decision hangs on belongs in `core` instead. Engine HTML is
 * never trusted — see `ENGINE_HTML_KEYS`.
 *
 * This schema is authoritative for TypeScript. `engine/service/contract.py`
 * mirrors it, and `shared/curation/document.test.ts` fails if they disagree.
 */

export const CURATION_CONTRACT_VERSION = "1.0" as const;

/** ACMG strength buckets as emitted by `vc_engine/scoring.py`. */
export const criterionStrengths = [
  "stand_alone",
  "very_strong",
  "strong",
  "moderate",
  "supporting",
] as const;

/**
 * `parsed_data` keys whose values are engine-rendered HTML.
 *
 * Only these are rendered as markup, and only after DOMPurify, because they embed
 * strings fetched from ClinVar, HGMD and UniProt. Every other key renders as text,
 * so a key missing from this list shows literal tags rather than becoming an
 * injection point — the failure mode is cosmetic, not a security hole.
 * `test_html_key_list_covers_every_html_value` keeps the list current.
 */
export const ENGINE_HTML_KEYS = [
  "clinical_publication_summary_html",
  "cryptic_splice_narrative",
  "deep_intronic_splice_html",
  "junction_model_summary",
  "logic_explanation",
  "splice_frame_math",
  "splice_frame_math_exon_skip_ref",
  "splice_products_panel_html",
  "splice_pvs1_logic_sentence",
  "spliceai_secondary_splice_frame_math",
] as const;

export const curationMetaSchema = z.object({
  /** Engine build that produced the document, e.g. "v11". */
  engineVersion: z.string().min(1).max(40),
  generatedAt: z.string().min(1),
  durationMs: z.int().min(0),
  /** The engine hardcodes hg38 in its external API calls. */
  referenceBuild: z.literal("GRCh38"),
  /** Sources actually queried for this run. */
  sourcesConsulted: z.array(z.string().min(1)),
  /** Sources skipped by configuration, e.g. "hgmd" when ENGINE_HGMD_ENABLED=false. */
  sourcesDisabled: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
});

export const curationExonSchema = z.object({
  rank: z.int().nullable(),
  total: z.int().nullable(),
  codingRank: z.int().nullable(),
  codingTotal: z.int().nullable(),
  mrnaTotal: z.int().nullable(),
});

export const curationVariantSchema = z.object({
  gene: z.string().min(1).max(80),
  /** Symbol the engine resolved to, which can differ from the requested gene. */
  effectiveGene: z.string().max(80).nullable(),
  transcript: z.string().max(120).nullable(),
  ensemblTranscriptId: z.string().max(60).nullable(),
  hgvsC: z.string().min(1).max(255),
  hgvsP: z.string().max(255).nullable(),
  consequence: z.string().max(160).nullable(),
  chromosome: z.string().max(16).nullable(),
  start: z.int().nullable(),
  end: z.int().nullable(),
  referenceAllele: z.string().nullable(),
  alternateAllele: z.string().nullable(),
  strand: z.int().nullable(),
  proteinLength: z.int().nullable(),
  exon: curationExonSchema,
});

export const spliceAiScoresSchema = z.object({
  dsAg: z.number().nullable(),
  dsAl: z.number().nullable(),
  dsDg: z.number().nullable(),
  dsDl: z.number().nullable(),
  dpAg: z.int().nullable(),
  dpAl: z.int().nullable(),
  dpDg: z.int().nullable(),
  dpDl: z.int().nullable(),
  fetched: z.boolean(),
  source: z.string().max(60).nullable(),
});

export const pangolinScoresSchema = z.object({
  dsSg: z.number().nullable(),
  dsSl: z.number().nullable(),
  dpSg: z.int().nullable(),
  dpSl: z.int().nullable(),
  fetched: z.boolean(),
});

/** Numeric evidence the triage pass thresholds on. */
export const curationScoresSchema = z.object({
  gnomadAf: z.number().nullable(),
  caddPhred: z.number().nullable(),
  revelScore: z.number().nullable(),
  spliceAi: spliceAiScoresSchema,
  pangolin: pangolinScoresSchema,
});

export const curationCriterionSchema = z.object({
  /** Engine code, which may carry a strength suffix such as "PVS1_Strong". */
  code: z.string().min(2).max(24),
  /** Code stripped of any strength suffix; always a bare ACMG 2015 code. */
  baseCode: z.string().min(2).max(8),
  strength: z.enum(criterionStrengths),
  direction: z.enum(["pathogenic", "benign"]),
  rationale: z.string(),
});

export const curationAcmgSchema = z.object({
  criteria: z.array(curationCriterionSchema),
  classification: z
    .object({
      label: z.string().min(1).max(80),
      class: z.enum(["pathogenic", "benign", "vus"]),
    })
    .nullable(),
});

/**
 * The handful of non-numeric engine facts that server logic branches on. Anything
 * the server only forwards to the UI stays in the pass-through layer instead.
 */
export const curationHighlightsSchema = z.object({
  clinvarSignificance: z.string().nullable(),
  clinvarIdenticalPathogenic: z.boolean(),
  hgmdEnabled: z.boolean(),
  hgmdMatch: z.string().nullable(),
  spliceApplicable: z.boolean(),
  spliceIsInFrame: z.boolean().nullable(),
  spliceNmdEscape: z.boolean().nullable(),
  literatureStatus: z.string().max(40),
});

/**
 * The engine's response, unmodified. Validated only for container shape so that a
 * new or renamed engine fact can never fail a run.
 */
export const curationEngineSchema = z.object({
  /** `parsed_data` verbatim: every fact the engine computed, ~190 keys. */
  parsedData: z.record(z.string(), z.unknown()),
  /** `results_acmg` verbatim, as `vc_engine/scoring.py` emitted it. */
  resultsAcmg: z.unknown(),
  /** `results_custom` verbatim: the institutional rubric, when enabled. */
  resultsCustom: z.unknown(),
  /** Literature block attached after analysis by `enrich_with_literature`. */
  literature: z.unknown(),
  geneSummary: z.string().nullable(),
});

export const curationDocumentSchema = z.object({
  contractVersion: z.literal(CURATION_CONTRACT_VERSION),
  meta: curationMetaSchema,
  variant: curationVariantSchema,
  scores: curationScoresSchema,
  acmg: curationAcmgSchema,
  highlights: curationHighlightsSchema,
  engine: curationEngineSchema,
});

export type CurationDocument = z.infer<typeof curationDocumentSchema>;
export type CurationCriterion = z.infer<typeof curationCriterionSchema>;
export type CurationScores = z.infer<typeof curationScoresSchema>;
export type CurationHighlights = z.infer<typeof curationHighlightsSchema>;
export type CriterionStrength = (typeof criterionStrengths)[number];

/** Largest of the four SpliceAI delta scores, used for triage and list sorting. */
export function spliceAiMax(scores: CurationScores): number {
  return Math.max(
    scores.spliceAi.dsAg ?? 0,
    scores.spliceAi.dsAl ?? 0,
    scores.spliceAi.dsDg ?? 0,
    scores.spliceAi.dsDl ?? 0
  );
}

/**
 * Compact projection stored in `curation_runs.summary` for list views and
 * queries. The full document lives in object storage.
 */
export function buildCurationSummary(doc: CurationDocument) {
  return {
    contractVersion: doc.contractVersion,
    engineVersion: doc.meta.engineVersion,
    classification: doc.acmg.classification,
    criteriaCodes: doc.acmg.criteria.map(criterion => criterion.code),
    gene: doc.variant.effectiveGene || doc.variant.gene,
    hgvsC: doc.variant.hgvsC,
    hgvsP: doc.variant.hgvsP,
    consequence: doc.variant.consequence,
    gnomadAf: doc.scores.gnomadAf,
    caddPhred: doc.scores.caddPhred,
    revelScore: doc.scores.revelScore,
    spliceAiMax: spliceAiMax(doc.scores),
    clinvarSignificance: doc.highlights.clinvarSignificance,
    spliceApplicable: doc.highlights.spliceApplicable,
    literatureStatus: doc.highlights.literatureStatus,
    sourcesConsulted: doc.meta.sourcesConsulted,
    sourcesDisabled: doc.meta.sourcesDisabled,
    warnings: doc.meta.warnings,
  };
}

export type CurationSummary = ReturnType<typeof buildCurationSummary>;

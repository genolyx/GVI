/**
 * Triage: decide which variants are worth engine time.
 *
 * `parseVcf` accepts up to 50,000 variants per case and the curation engine takes
 * one to five minutes each, so curating everything is not economically possible.
 * This pass runs in Node against data already in the row — no external calls — and
 * sorts variants into three tiers.
 *
 * The rules are intentionally recall-oriented. A false positive costs engine
 * minutes; a false negative can mean a missed diagnosis, so anything plausibly
 * causal lands in `t1_curate` or `t2_review` rather than being filtered. Filtering
 * never deletes: a reviewer can promote any variant by hand.
 *
 * Scores exist to order the queue within a tier, not to be a probability. They are
 * additive and deliberately coarse.
 */

export const TRIAGE_TIERS = ["t1_curate", "t2_review", "t3_filtered"] as const;
export type TriageTier = (typeof TRIAGE_TIERS)[number];

/**
 * Allele frequency above which a variant is too common to explain a rare disease.
 * 1% is the conventional ACMG BA1-adjacent cut-off for dominant conditions.
 */
const COMMON_AF = 0.01;
/** Frequency below which rarity itself is mild positive evidence (PM2 territory). */
const RARE_AF = 0.0001;

/** Consequence substrings that imply loss of function. */
const HIGH_IMPACT_CONSEQUENCES = [
  "frameshift",
  "stop_gained",
  "start_lost",
  "stop_lost",
  "splice_acceptor",
  "splice_donor",
  "transcript_ablation",
];

/** Consequences near a splice site, which the engine's splicing model excels at. */
const SPLICE_REGION_CONSEQUENCES = [
  "splice_region",
  "splice_polypyrimidine",
  "splice_donor_5th_base",
  "intron_variant",
];

const PATHOGENIC_CLINVAR = /\b(pathogenic|likely[_ ]pathogenic)\b/i;
const BENIGN_CLINVAR = /^\s*(benign|likely[_ ]benign)\s*$/i;
const CONFLICTING_CLINVAR = /conflicting/i;

/** The subset of a variant row triage reads. */
export type TriageInput = {
  gene: string | null;
  consequence: string | null;
  impact: string;
  /** Decimal string from Postgres `numeric`, or null when unknown. */
  populationAf: string | number | null;
  clinvarSignificance: string | null;
  hgvsC: string | null;
  referenceBuild: string;
};

export type TriageVerdict = {
  tier: TriageTier;
  score: number;
  reasons: string[];
};

export type TriageContext = {
  /**
   * Genes on the ordered panel, upper-cased. Empty means exome or genome scope, in
   * which case gene membership contributes nothing rather than penalising every
   * variant.
   */
  panelGenes?: ReadonlySet<string>;
};

function parseAf(raw: string | number | null): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function matchesAny(haystack: string | null, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some(needle => lower.includes(needle));
}

/**
 * Score one variant and assign a tier.
 *
 * Exported separately from the bulk pass so the Workbench can explain a single
 * variant's tier without re-running the whole case.
 */
export function triageVariant(variant: TriageInput, context: TriageContext = {}): TriageVerdict {
  const reasons: string[] = [];
  let score = 0;

  const af = parseAf(variant.populationAf);
  const clinvar = variant.clinvarSignificance;
  const panelGenes = context.panelGenes;

  // ── Hard stops ───────────────────────────────────────────────────────────────

  // ClinVar pathogenic outranks everything else: it is a curated human assertion,
  // so it goes to the engine even if the variant is otherwise unremarkable.
  const clinvarPathogenic = !!clinvar && PATHOGENIC_CLINVAR.test(clinvar);
  if (clinvarPathogenic) {
    reasons.push(`ClinVar reports ${clinvar}`);
    score += 60;
  }

  // Too common to cause a rare disease. Overridden by a ClinVar P/LP assertion,
  // because well-known founder variants can exceed the threshold.
  if (af !== null && af >= COMMON_AF && !clinvarPathogenic) {
    return {
      tier: "t3_filtered",
      score: 0,
      reasons: [`Population AF ${af.toExponential(2)} is at or above ${COMMON_AF}`],
    };
  }

  // A confident benign assertion with no countervailing evidence is parked.
  if (clinvar && BENIGN_CLINVAR.test(clinvar) && !clinvarPathogenic) {
    return {
      tier: "t3_filtered",
      score: 0,
      reasons: [`ClinVar reports ${clinvar}`],
    };
  }

  // The engine is driven by gene + HGVS c., not coordinates. GRCh37 genomic
  // positions are lifted at enqueue; missing HGVS is the actual blocker.
  if (!variant.gene || !variant.hgvsC) {
    return {
      tier: "t2_review",
      score: 0,
      reasons: ["Missing gene symbol or HGVSc required by the engine"],
    };
  }

  // ── Additive evidence ────────────────────────────────────────────────────────

  if (variant.impact === "HIGH") {
    reasons.push("Predicted HIGH impact");
    score += 40;
  } else if (variant.impact === "MODERATE") {
    reasons.push("Predicted MODERATE impact");
    score += 20;
  }

  if (matchesAny(variant.consequence, HIGH_IMPACT_CONSEQUENCES)) {
    reasons.push(`Loss-of-function consequence (${variant.consequence})`);
    score += 25;
  } else if (matchesAny(variant.consequence, SPLICE_REGION_CONSEQUENCES)) {
    // The engine's splicing subsystem is its strongest capability, so a splice
    // region variant is worth curating even when annotation calls it low impact.
    reasons.push(`Splice-region consequence (${variant.consequence})`);
    score += 25;
  }

  if (af === null) {
    reasons.push("No population frequency available");
    score += 5;
  } else if (af <= RARE_AF) {
    reasons.push(`Rare in population (AF ${af.toExponential(2)})`);
    score += 15;
  }

  if (panelGenes?.size && panelGenes.has(variant.gene.toUpperCase())) {
    reasons.push("Gene is on the ordered panel");
    score += 30;
  }

  if (clinvar && CONFLICTING_CLINVAR.test(clinvar)) {
    // Conflicting submissions are exactly where engine evidence adds most value.
    reasons.push(`ClinVar submissions conflict (${clinvar})`);
    score += 20;
  }

  // ── Tier assignment ──────────────────────────────────────────────────────────

  if (score >= 55) return { tier: "t1_curate", score, reasons };
  if (score >= 20) return { tier: "t2_review", score, reasons };
  return {
    tier: "t3_filtered",
    score,
    reasons: reasons.length ? reasons : ["No triage rule fired"],
  };
}

/** Panel gene symbols parsed from `cases.panelName`, upper-cased. */
export function parsePanelGenes(panelName: string | null): Set<string> {
  if (!panelName) return new Set();
  // Panels are recorded free-text, e.g. "Epilepsy panel: SCN1A, KCNQ2, STXBP1".
  const listPart = panelName.includes(":") ? panelName.slice(panelName.indexOf(":") + 1) : panelName;
  const symbols = listPart
    .split(/[,;/|]/)
    .map(token => token.trim().toUpperCase())
    .filter(token => /^[A-Z][A-Z0-9-]{1,19}$/.test(token));
  return new Set(symbols);
}

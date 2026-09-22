/**
 * GRCh37 → GRCh38 genomic lift via Ensembl's assembly converter.
 *
 * The curation engine hardcodes hg38 in SpliceAI / Pangolin / Ensembl lookups.
 * A GRCh37 VCF therefore cannot hand those services its own chrom:pos. HGVS c.
 * is transcript-relative and is safe to send as-is; the genomic locus is what
 * must move. We lift at enqueue (one variant at a time), never across a whole
 * VCF — Ensembl's rate limit would make a 50k-row ingest stall.
 *
 * Failure is not fatal when the variant already has gene + HGVS c.: the engine
 * resolves coordinates from the transcript on GRCh38 itself. A failed lift is
 * recorded so the reviewer can see the submitted assembly was not remapped.
 */

export type LiftedLocus = {
  chromosome: string;
  position: number;
  source: "ensembl_map";
  from: { build: "GRCh37"; chromosome: string; position: number };
};

export type LiftResult =
  | { ok: true; locus: LiftedLocus }
  | { ok: false; reason: string };

const ENSEMBL_REST = "https://rest.ensembl.org";

/** Strip a leading `chr` so Ensembl and VCF chrom names compare equal. */
export function normalizeChromosome(raw: string): string {
  return raw.replace(/^chr/i, "");
}

export function ensemblMapUrl(chromosome: string, position: number): string {
  const chrom = encodeURIComponent(normalizeChromosome(chromosome));
  return `${ENSEMBL_REST}/map/human/GRCh37/${chrom}:${position}..${position}/GRCh38?content-type=application/json`;
}

type EnsemblMapping = {
  mappings?: Array<{
    mapped?: { seq_region_name?: string; start?: number; end?: number };
  }>;
};

export function parseEnsemblMap(
  payload: unknown,
  from: { chromosome: string; position: number }
): LiftResult {
  const mappings = (payload as EnsemblMapping | null)?.mappings;
  const mapped = mappings?.[0]?.mapped;
  const chromosome = mapped?.seq_region_name ? normalizeChromosome(mapped.seq_region_name) : "";
  const position = mapped?.start;
  if (!chromosome || !Number.isInteger(position) || (position as number) <= 0) {
    return { ok: false, reason: "Ensembl returned no GRCh38 mapping for this locus" };
  }
  return {
    ok: true,
    locus: {
      chromosome,
      position: position as number,
      source: "ensembl_map",
      from: { build: "GRCh37", chromosome: normalizeChromosome(from.chromosome), position: from.position },
    },
  };
}

export async function liftGrch37To38(
  chromosome: string,
  position: number,
  fetchImpl: typeof fetch = fetch
): Promise<LiftResult> {
  if (!chromosome || !Number.isInteger(position) || position <= 0) {
    return { ok: false, reason: "Genomic locus is missing or invalid" };
  }
  const url = ensemblMapUrl(chromosome, position);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `Ensembl map returned HTTP ${response.status}` };
    }
    return parseEnsemblMap(await response.json(), { chromosome, position });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ensembl map request failed";
    return { ok: false, reason: message };
  }
}

/**
 * Decide the assembly the engine should treat as current.
 *
 * GRCh38 is used as-is. GRCh37 is lifted when Ensembl answers; otherwise the
 * submitted build stays on the run so the reviewer can see the gap.
 */
export async function resolveEngineBuild(input: {
  referenceBuild: "GRCh37" | "GRCh38";
  chromosome?: string | null;
  position?: number | null;
}): Promise<{
  referenceBuild: "GRCh37" | "GRCh38";
  submittedBuild: "GRCh37" | "GRCh38";
  liftedLocus: LiftedLocus | null;
  liftError: string | null;
}> {
  if (input.referenceBuild !== "GRCh37") {
    return {
      referenceBuild: "GRCh38",
      submittedBuild: "GRCh38",
      liftedLocus: null,
      liftError: null,
    };
  }
  const lift = await liftGrch37To38(input.chromosome || "", input.position || 0);
  if (lift.ok) {
    return {
      referenceBuild: "GRCh38",
      submittedBuild: "GRCh37",
      liftedLocus: lift.locus,
      liftError: null,
    };
  }
  return {
    referenceBuild: "GRCh37",
    submittedBuild: "GRCh37",
    liftedLocus: null,
    liftError: lift.reason,
  };
}

import { createHash } from "node:crypto";
import { parseGeneList } from "@shared/geneList";

export type GermlinePanelRegion = {
  chromosome: string;
  /** 1-based inclusive start. */
  start: number;
  /** 1-based inclusive end. */
  end: number;
  name: string | null;
};

export type GermlinePanelContent = {
  genes: string[];
  regions: GermlinePanelRegion[] | null;
};

const MAX_REGIONS = 100_000;
const MAX_GENES = 5_000;

export function germlinePanelHash(
  content: GermlinePanelContent,
  genomeBuild: "GRCh37" | "GRCh38" | null
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        genomeBuild,
        genes: [...content.genes].sort(),
        regions: content.regions,
      })
    )
    .digest("hex");
}

export function parseGermlineGeneText(text: string): string[] {
  const genes = parseGeneList(text);
  if (!genes?.size) {
    throw new Error("Enter at least one gene symbol.");
  }
  if (genes.size > MAX_GENES) {
    throw new Error(`A germline panel can contain at most ${MAX_GENES} genes.`);
  }
  return Array.from(genes).sort();
}

/** Strict BED is 0-based, half-open. Stored intervals are 1-based and inclusive. */
export function parseGermlineBed(text: string): GermlinePanelContent {
  const regions: GermlinePanelRegion[] = [];
  const genes = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("track") ||
      line.startsWith("browser")
    ) {
      continue;
    }
    const columns = line.split("\t");
    if (columns.length < 3) {
      throw new Error("BED rows need chromosome, start, and end columns.");
    }
    const chromosome = columns[0].trim();
    const start0 = Number(columns[1]);
    const endExclusive = Number(columns[2]);
    if (
      !chromosome ||
      !Number.isInteger(start0) ||
      !Number.isInteger(endExclusive) ||
      start0 < 0 ||
      endExclusive <= start0
    ) {
      throw new Error(`Invalid BED interval: ${line.slice(0, 120)}`);
    }
    const name = columns[3]?.trim() || null;
    const namedGenes = name ? parseGeneList(name) : null;
    namedGenes?.forEach(gene => genes.add(gene));
    regions.push({
      chromosome,
      start: start0 + 1,
      end: endExclusive,
      name,
    });
    if (regions.length > MAX_REGIONS) {
      throw new Error(`A BED panel can contain at most ${MAX_REGIONS} intervals.`);
    }
  }
  if (!regions.length) throw new Error("BED contains no intervals.");
  if (genes.size > MAX_GENES) {
    throw new Error(`A germline panel can contain at most ${MAX_GENES} genes.`);
  }
  return { genes: Array.from(genes).sort(), regions };
}

export function chromosomeKey(value: string) {
  return value.replace(/^chr/i, "").toUpperCase();
}

export function variantOverlapsPanel(
  variant: {
    chromosome?: string;
    position?: number;
    referenceAllele?: string;
  },
  regions: readonly { chromosome: string; start: number; end: number }[]
) {
  if (!variant.chromosome || variant.position == null) return false;
  const chromosome = chromosomeKey(variant.chromosome);
  const start = variant.position;
  const end = start + Math.max((variant.referenceAllele?.length ?? 1) - 1, 0);
  return regions.some(
    region =>
      chromosomeKey(region.chromosome) === chromosome &&
      start <= region.end &&
      end >= region.start
  );
}

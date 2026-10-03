import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { gnomadSiteKey } from "./gnomadLocal";
import { clinvarContig, clinvarVcfPath } from "./variantIdentity";

const execFileAsync = promisify(execFile);

/** ClinVar CLNSIG as stored text. Underscores become spaces so the filter can read the words. */
export function formatClnsig(value: string | null | undefined): string | null {
  if (!value || value === "." || value.toLowerCase() === "not_provided") return null;
  const text = value.replaceAll("_", " ").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Allele-matched ClinVar classifications.
 * A record is used only when chromosome, position, ref, and alt are the same.
 * The opposite allele at that position is not copied onto this variant.
 */
export function clinvarSignificanceFromVcfLines(
  lines: Iterable<string>,
  wanted: ReadonlySet<string>
): Map<string, string> {
  const found = new Map<string, string>();
  if (!wanted.size) return found;
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    if (found.size === wanted.size) break;
    const columns = line.split("\t");
    if (columns.length < 8) continue;
    const [chromosome, positionRaw, , referenceAllele, alternateAllele, , , info] = columns;
    if (!chromosome || !referenceAllele || !alternateAllele || alternateAllele.includes(",")) continue;
    const position = Number(positionRaw);
    if (!Number.isInteger(position)) continue;
    const key = gnomadSiteKey({ chromosome, position, referenceAllele, alternateAllele });
    if (!wanted.has(key) || found.has(key)) continue;
    const raw = info.match(/(?:^|;)CLNSIG=([^;]*)/)?.[1];
    const significance = formatClnsig(raw);
    if (significance) found.set(key, significance);
  }
  return found;
}

/** Variation ID when this exact ref/alt is the ClinVar row at the position. */
export function clinvarVariationIdFromLines(text: string, ref: string, alt: string): string | null {
  const wantRef = ref.trim().toUpperCase();
  const wantAlt = alt.trim().toUpperCase();
  if (!wantRef || !wantAlt || wantAlt.includes(",")) return null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [rowRef = "", rowAlt = "", id = ""] = line.split("\t");
    if (rowAlt.includes(",")) continue;
    if (rowRef.toUpperCase() !== wantRef || rowAlt.toUpperCase() !== wantAlt) continue;
    if (!/^\d+$/.test(id.trim())) continue;
    return id.trim();
  }
  return null;
}

export type ClinvarVariationLookup = {
  /** False when the local file or tabix lookup could not be read. The saved claim is left as-is. */
  available: boolean;
  /** Variation ID for this exact ref/alt, or null when that allele is absent. */
  id: string | null;
};

/** The ClinVar variation at this genomic allele. */
export async function clinvarVariationIdAt(
  chromosome: string,
  position: number,
  ref: string,
  alt: string
): Promise<ClinvarVariationLookup> {
  const contig = clinvarContig(chromosome);
  if (!contig || !Number.isInteger(position)) return { available: false, id: null };
  const file = clinvarVcfPath();
  try {
    await access(file);
  } catch {
    return { available: false, id: null };
  }
  try {
    const { stdout } = await execFileAsync(
      "bcftools",
      ["query", "-f", "%REF\t%ALT\t%ID\n", "-r", `${contig}:${position}-${position}`, file],
      { timeout: 8000 }
    );
    return { available: true, id: clinvarVariationIdFromLines(stdout, ref, alt) };
  } catch {
    return { available: false, id: null };
  }
}

/** Null when the local ClinVar VCF is not installed. */
export async function clinvarSignificanceForSites(wanted: ReadonlySet<string>): Promise<Map<string, string> | null> {
  const file = clinvarVcfPath();
  try {
    await access(file);
  } catch {
    return null;
  }
  const found = new Map<string, string>();
  if (!wanted.size) return found;
  const input = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (found.size === wanted.size) break;
    for (const [key, significance] of clinvarSignificanceFromVcfLines([line], wanted)) {
      if (!found.has(key)) found.set(key, significance);
    }
  }
  lines.close();
  input.destroy();
  return found;
}

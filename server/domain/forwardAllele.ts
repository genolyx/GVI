import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MISSING = new Set(["", "-", "."]);
const COMPLEMENT: Record<string, string> = { A: "T", C: "G", G: "C", T: "A", N: "N" };

export type ForwardAllele = { position: number; ref: string; alt: string };

export function referenceFastaPath(): string {
  const override = (process.env.VC_REFERENCE_FASTA || "").trim();
  if (override) return override;
  const root = (process.env.GX_EXOME_DATA_DIR || "/home/ken/gx-exome").trim();
  return path.join(root, "data", "refs", "GRCh38.fasta");
}

function revcomp(sequence: string): string {
  return sequence
    .split("")
    .reverse()
    .map(base => COMPLEMENT[base] ?? "")
    .join("");
}

function clean(value: string): string | null {
  const text = value.trim().toUpperCase();
  if (MISSING.has(text)) return "";
  if ([...text].some(base => !COMPLEMENT[base])) return null;
  return text;
}

function matches(position: number, sequence: string, baseAt: (site: number) => string | null): boolean {
  if (!sequence) return true;
  let bases = "";
  for (let offset = 0; offset < sequence.length; offset += 1) {
    const base = baseAt(position + offset);
    if (!base) return false;
    bases += base;
  }
  return bases === sequence;
}

/**
 * Left-align an indel onto the forward reference, in VCF form.
 * A single-base change returns null so the caller keeps the original allele.
 */
export function alignForwardIndel(
  position: number,
  ref: string,
  alt: string,
  baseAt: (site: number) => string | null
): ForwardAllele | null {
  if (!Number.isInteger(position) || position < 1) return null;
  let refSeq = clean(ref);
  let altSeq = clean(alt);
  if (refSeq === null || altSeq === null) return null;
  if (!refSeq && !altSeq) return null;
  if (refSeq && altSeq && refSeq.length === altSeq.length) return null;
  let pos = position;

  if (refSeq && !matches(pos, refSeq, baseAt)) {
    const flippedRef = revcomp(refSeq);
    const flippedAlt = altSeq ? revcomp(altSeq) : "";
    if (!flippedRef || (altSeq && !flippedAlt) || !matches(pos, flippedRef, baseAt)) return null;
    refSeq = flippedRef;
    altSeq = flippedAlt;
  }

  while (refSeq && altSeq && refSeq.at(-1) === altSeq.at(-1)) {
    refSeq = refSeq.slice(0, -1);
    altSeq = altSeq.slice(0, -1);
  }
  while (refSeq && altSeq && refSeq[0] === altSeq[0]) {
    refSeq = refSeq.slice(1);
    altSeq = altSeq.slice(1);
    pos += 1;
  }
  if (!refSeq || !altSeq) {
    if (pos <= 1) return null;
    pos -= 1;
    const anchor = baseAt(pos);
    if (!anchor) return null;
    refSeq = anchor + refSeq;
    altSeq = anchor + altSeq;
  }

  let steps = 0;
  while (pos > 1 && refSeq && altSeq && refSeq.at(-1) === altSeq.at(-1)) {
    steps += 1;
    if (steps > 10000) return null;
    pos -= 1;
    const anchor = baseAt(pos);
    if (!anchor) return null;
    refSeq = anchor + refSeq;
    altSeq = anchor + altSeq;
    while (refSeq && altSeq && refSeq.at(-1) === altSeq.at(-1)) {
      refSeq = refSeq.slice(0, -1);
      altSeq = altSeq.slice(0, -1);
    }
  }
  if (!refSeq || !altSeq || !matches(pos, refSeq, baseAt)) return null;
  return { position: pos, ref: refSeq, alt: altSeq };
}

function contigCandidates(chromosome: string): string[] {
  const bare = chromosome.trim().replace(/^chr/i, "");
  const name = bare.toUpperCase() === "MT" ? "M" : bare;
  return [`chr${name}`, name];
}

async function referenceWindow(
  chromosome: string,
  start: number,
  end: number
): Promise<{ contigStart: number; sequence: string } | null> {
  const file = referenceFastaPath();
  try {
    await access(file);
  } catch {
    return null;
  }
  for (const contig of contigCandidates(chromosome)) {
    try {
      const { stdout } = await execFileAsync(
        "samtools",
        ["faidx", file, `${contig}:${start}-${end}`],
        { timeout: 8000 }
      );
      const sequence = stdout
        .split("\n")
        .filter(line => line && !line.startsWith(">"))
        .join("")
        .toUpperCase();
      if (sequence) return { contigStart: start, sequence };
    } catch {
      // Try the other contig spelling.
    }
  }
  return null;
}

/** The stored indel in forward-strand VCF form. The original allele when it cannot be proven. */
export async function alignStoredIndel(
  chromosome: string,
  position: number,
  ref: string,
  alt: string
): Promise<ForwardAllele> {
  const original = { position, ref, alt };
  const refText = ref.trim().toUpperCase();
  const altText = alt.trim().toUpperCase();
  const indel =
    refText === "-" ||
    altText === "-" ||
    refText === "." ||
    altText === "." ||
    (refText.length > 0 && altText.length > 0 && refText.length !== altText.length);
  if (!indel || !Number.isInteger(position)) return original;
  const pad = 4096;
  const start = Math.max(1, position - pad);
  const end = position + Math.max(refText.length, altText.length, 1) + 32;
  const window = await referenceWindow(chromosome, start, end);
  if (!window) return original;
  const aligned = alignForwardIndel(position, ref, alt, site => {
    const index = site - window.contigStart;
    if (index < 0 || index >= window.sequence.length) return null;
    return window.sequence[index] ?? null;
  });
  return aligned ?? original;
}

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import type { Variant } from "../../../drizzle/schema";

type FaiRecord = {
  name: string;
  length: number;
  offset: number;
  basesPerLine: number;
  bytesPerLine: number;
};

export type ReferenceFastaSource = {
  build: Variant["referenceBuild"];
  fastaPath: string;
  expectedSha256: string;
  version: string;
};

export type VerifiedIndelNormalization = {
  chromosome: string;
  position: number;
  reference: string;
  alternate: string;
  normalizedId: string;
  shiftedBases: number;
  referenceProvenance: {
    fastaVersion: string;
    fastaSha256: string;
    fastaPath: string;
    faiPath: string;
  };
};

type OpenReference = {
  source: ReferenceFastaSource;
  handle: FileHandle;
  index: Map<string, FaiRecord>;
};

const references = new Map<string, Promise<OpenReference>>();

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function sourceFromEnv(
  build: Variant["referenceBuild"]
): ReferenceFastaSource | null {
  const suffix = build.toUpperCase();
  const fastaPath = process.env[`SOMATIC_REFERENCE_FASTA_${suffix}`]?.trim();
  const expectedSha256 = process.env[
    `SOMATIC_REFERENCE_FASTA_${suffix}_SHA256`
  ]
    ?.trim()
    .toLowerCase();
  const version =
    process.env[`SOMATIC_REFERENCE_FASTA_${suffix}_VERSION`]?.trim() ?? build;
  if (!fastaPath || !expectedSha256) return null;
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`${suffix} reference FASTA SHA-256 is invalid.`);
  }
  return { build, fastaPath, expectedSha256, version };
}

function contigAliases(name: string): string[] {
  const bare = name.replace(/^chr/i, "");
  return Array.from(new Set([name, bare, `chr${bare}`]));
}

async function openReference(source: ReferenceFastaSource): Promise<OpenReference> {
  const key = `${source.fastaPath}\0${source.expectedSha256}`;
  let pending = references.get(key);
  if (!pending) {
    pending = (async () => {
      const faiPath = `${source.fastaPath}.fai`;
      const [fastaInfo, indexText, handle, actualSha256] = await Promise.all([
        stat(source.fastaPath),
        readFile(faiPath, "utf8"),
        open(source.fastaPath, "r"),
        sha256File(source.fastaPath),
      ]);
      if (!fastaInfo.isFile()) throw new Error("Reference FASTA is not a file.");
      if (actualSha256 !== source.expectedSha256) {
        await handle.close();
        throw new Error(
          `Reference FASTA SHA-256 mismatch for ${source.build}.`
        );
      }
      const index = new Map<string, FaiRecord>();
      for (const line of indexText.split(/\r?\n/)) {
        if (!line) continue;
        const [name, length, offset, basesPerLine, bytesPerLine] =
          line.split("\t");
        const record = {
          name,
          length: Number(length),
          offset: Number(offset),
          basesPerLine: Number(basesPerLine),
          bytesPerLine: Number(bytesPerLine),
        };
        if (
          !name ||
          !Number.isSafeInteger(record.length) ||
          !Number.isSafeInteger(record.offset) ||
          !Number.isSafeInteger(record.basesPerLine) ||
          !Number.isSafeInteger(record.bytesPerLine) ||
          record.length < 1 ||
          record.offset < 0 ||
          record.basesPerLine < 1 ||
          record.bytesPerLine < record.basesPerLine
        ) {
          await handle.close();
          throw new Error(`Invalid FASTA index row for ${name || "unknown"}.`);
        }
        for (const alias of contigAliases(name)) index.set(alias, record);
      }
      return { source, handle, index };
    })();
    references.set(key, pending);
  }
  return pending;
}

async function readSequence(
  reference: OpenReference,
  chromosome: string,
  start: number,
  end: number
): Promise<string> {
  const record = contigAliases(chromosome)
    .map(alias => reference.index.get(alias))
    .find((candidate): candidate is FaiRecord => Boolean(candidate));
  if (!record) throw new Error(`Contig ${chromosome} is absent from FASTA.`);
  if (start < 1 || end < start || end > record.length) {
    throw new Error(
      `Reference interval ${chromosome}:${start}-${end} is out of range.`
    );
  }
  const chunks: string[] = [];
  let cursor = start - 1;
  while (cursor < end) {
    const lineOffset = cursor % record.basesPerLine;
    const bases = Math.min(
      end - cursor,
      record.basesPerLine - lineOffset
    );
    const fileOffset =
      record.offset +
      Math.floor(cursor / record.basesPerLine) * record.bytesPerLine +
      lineOffset;
    const buffer = Buffer.allocUnsafe(bases);
    const result = await reference.handle.read(buffer, 0, bases, fileOffset);
    if (result.bytesRead !== bases) {
      throw new Error(`Reference FASTA ended inside ${chromosome}.`);
    }
    chunks.push(buffer.toString("ascii"));
    cursor += bases;
  }
  return chunks.join("").toUpperCase();
}

/**
 * Repeat-aware left normalization using an indexed, externally SHA-pinned
 * reference FASTA. The full digest is verified once per process and cached;
 * every interpretation records the pinned version and SHA-256.
 */
export async function normalizeIndelWithReference(
  variant: Variant,
  source: ReferenceFastaSource | null = sourceFromEnv(variant.referenceBuild)
): Promise<VerifiedIndelNormalization | null> {
  if (variant.variantType !== "INDEL" || !source) return null;
  if (source.build !== variant.referenceBuild) {
    throw new Error("Reference FASTA build does not match the variant build.");
  }
  const reference = await openReference(source);
  const chromosome = variant.chromosome.replace(/^chr/i, "");
  let position = variant.position;
  let ref = variant.referenceAllele.toUpperCase();
  let alt = variant.alternateAllele.toUpperCase();
  if (!/^[ACGTN]+$/.test(ref) || !/^[ACGTN]+$/.test(alt)) {
    throw new Error("INDEL alleles contain unsupported reference symbols.");
  }
  const submittedReference = await readSequence(
    reference,
    chromosome,
    position,
    position + ref.length - 1
  );
  if (submittedReference !== ref) {
    throw new Error(
      `Submitted REF does not match ${source.build} FASTA at ${chromosome}:${position}.`
    );
  }

  while (
    ref.length > 1 &&
    alt.length > 1 &&
    ref.at(-1) === alt.at(-1)
  ) {
    ref = ref.slice(0, -1);
    alt = alt.slice(0, -1);
  }
  while (
    ref.length > 1 &&
    alt.length > 1 &&
    ref[0] === alt[0]
  ) {
    ref = ref.slice(1);
    alt = alt.slice(1);
    position += 1;
  }

  const startingPosition = position;
  while (position > 1 && ref.at(-1) === alt.at(-1)) {
    const previous = await readSequence(
      reference,
      chromosome,
      position - 1,
      position - 1
    );
    ref = previous + ref.slice(0, -1);
    alt = previous + alt.slice(0, -1);
    position -= 1;
  }

  while (
    ref.length > 1 &&
    alt.length > 1 &&
    ref[0] === alt[0]
  ) {
    ref = ref.slice(1);
    alt = alt.slice(1);
    position += 1;
  }

  return {
    chromosome,
    position,
    reference: ref,
    alternate: alt,
    normalizedId: `${variant.referenceBuild}:${chromosome}:${position}:${ref}:${alt}`,
    shiftedBases: startingPosition - position,
    referenceProvenance: {
      fastaVersion: source.version,
      fastaSha256: source.expectedSha256,
      fastaPath: source.fastaPath,
      faiPath: `${source.fastaPath}.fai`,
    },
  };
}

export function resetReferenceFastaCacheForTests(): void {
  references.clear();
}

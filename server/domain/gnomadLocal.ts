import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  gnomadModePath,
  gnomadReleaseDirectories,
  parseGnomadMode,
} from "./referenceData";

const execFileAsync = promisify(execFile);
const CHR_IN_NAME = /(?:^|[._])chr([0-9]+|[xyxm])(?:[._]|$)/i;

export type GnomadSite = {
  chromosome: string;
  position: number;
  referenceAllele: string;
  alternateAllele: string;
};

export function bareChromosome(value: string): string {
  const bare = value.trim().replace(/^chr/i, "");
  return bare.toUpperCase() === "MT" ? "M" : bare;
}

export function gnomadSiteKey(site: GnomadSite): string {
  return [
    bareChromosome(site.chromosome).toUpperCase(),
    site.position,
    site.referenceAllele.toUpperCase(),
    site.alternateAllele.toUpperCase(),
  ].join(":");
}

/** Same preference as the classifier: non-zero exomes, then genomes, then a zero exome AF. */
export function chooseGnomadAf(exomes: number | null, genomes: number | null): number | null {
  if (exomes !== null && exomes !== 0) return exomes;
  if (genomes !== null) return genomes;
  if (exomes !== null) return exomes;
  return null;
}

/** `chr1` must not match `chr10`. One file with no chromosome token covers every chromosome. */
export function pickChromosomeFile(files: string[], chromosome: string): string | null {
  const token = bareChromosome(chromosome).toLowerCase();
  if (!token) return null;
  const matches = files.filter(file => {
    const found = path.basename(file).match(CHR_IN_NAME);
    return found?.[1]?.toLowerCase() === token;
  });
  if (matches.length) return matches.sort()[0] ?? null;
  return files.length === 1 ? files[0] ?? null : null;
}

/** bcftools query lines: chrom, pos, ref, alt, AF. ALT and AF may be comma-separated. */
export function parseAlleleFrequencyLines(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [chrom, posText, ref, alt, afText] = line.split("\t");
    const position = Number(posText);
    if (!chrom || !ref || !alt || !Number.isInteger(position)) continue;
    const alts = alt.split(",");
    const frequencies = (afText ?? "").split(",");
    for (let index = 0; index < alts.length; index += 1) {
      const frequency = Number(frequencies[index] ?? "");
      if (!Number.isFinite(frequency)) continue;
      found.set(
        gnomadSiteKey({
          chromosome: chrom,
          position,
          referenceAllele: ref,
          alternateAllele: alts[index] ?? "",
        }),
        frequency
      );
    }
  }
  return found;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function selectedReleaseDirectory(): Promise<string | null> {
  const dataRoot =
    (process.env.VC_DATA_ROOT ?? "").trim() || path.join(os.homedir(), "gvi-data");
  let mode = null;
  try {
    mode = parseGnomadMode(await readFile(gnomadModePath(dataRoot), "utf8"));
  } catch {
    mode = null;
  }
  if (mode === "myvariant") return null;
  const v3 = expandHome((process.env.VC_GNOMAD_DIR ?? "").trim());
  const single = expandHome((process.env.VC_GNOMAD_PATH ?? "").trim());
  if (!v3 && !single) return null;
  if (mode === "v4.1" && v3) {
    return gnomadReleaseDirectories(v3).find(release => release.release === "v4.1")?.dir ?? null;
  }
  return v3 || path.dirname(single);
}

async function cohortFiles(directory: string, cohort: "genomes" | "exomes"): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter(name => {
      if (!name.includes(`.${cohort}.`) && !name.includes(`${cohort}.v`)) return false;
      if (!/\.(?:bgz|vcf\.gz)$/.test(name)) return false;
      return /gnomad/i.test(name) && /sites/i.test(name);
    })
    .map(name => path.join(directory, name))
    .sort();
}

async function queryFile(
  file: string,
  sites: GnomadSite[]
): Promise<Map<string, number> | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gvi-gnomad-"));
  const regions = path.join(directory, "regions.txt");
  try {
    const contigPrefix = /(?:^|[._])chr/i.test(path.basename(file));
    const body = sites
      .map(site => {
        const chrom = bareChromosome(site.chromosome);
        const name = contigPrefix ? `chr${chrom}` : chrom;
        return `${name}\t${site.position}\t${site.position}`;
      })
      .join("\n");
    await writeFile(regions, `${body}\n`);
    const { stdout } = await execFileAsync(
      "bcftools",
      ["query", "-R", regions, "-f", "%CHROM\t%POS\t%REF\t%ALT\t%INFO/AF\n", file],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    );
    return parseAlleleFrequencyLines(stdout);
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Allele frequency from the same local gnomAD release the classifier reads.
 * A returned number of 0 means the site was queried and the allele is absent.
 * A missing key means that chromosome could not be read. `null` means local
 * gnomAD is not the selected source.
 */
export async function lookupLocalGnomad(
  sites: GnomadSite[]
): Promise<Map<string, number> | null> {
  if (!sites.length) return new Map();
  const directory = await selectedReleaseDirectory();
  if (!directory) return null;
  const [genomes, exomes] = await Promise.all([
    cohortFiles(directory, "genomes"),
    cohortFiles(directory, "exomes"),
  ]);
  if (!genomes.length && !exomes.length) return null;

  const byChrom = new Map<string, GnomadSite[]>();
  for (const site of sites) {
    const chrom = bareChromosome(site.chromosome).toUpperCase();
    const group = byChrom.get(chrom) ?? [];
    group.push(site);
    byChrom.set(chrom, group);
  }

  const genomeHits = new Map<string, number>();
  const exomeHits = new Map<string, number>();
  const genomesRead = new Set<string>();
  const exomesRead = new Set<string>();

  await Promise.all(
    Array.from(byChrom.entries()).map(async ([chrom, group]) => {
      const genomeFile = pickChromosomeFile(genomes, chrom);
      const exomeFile = pickChromosomeFile(exomes, chrom);
      const [genomeResult, exomeResult] = await Promise.all([
        genomeFile ? queryFile(genomeFile, group) : Promise.resolve(null),
        exomeFile ? queryFile(exomeFile, group) : Promise.resolve(null),
      ]);
      if (genomeResult) {
        genomesRead.add(chrom);
        for (const [key, frequency] of genomeResult) genomeHits.set(key, frequency);
      }
      if (exomeResult) {
        exomesRead.add(chrom);
        for (const [key, frequency] of exomeResult) exomeHits.set(key, frequency);
      }
    })
  );

  const frequencies = new Map<string, number>();
  for (const site of sites) {
    const chrom = bareChromosome(site.chromosome).toUpperCase();
    if (!genomesRead.has(chrom) && !exomesRead.has(chrom)) continue;
    const key = gnomadSiteKey(site);
    const chosen = chooseGnomadAf(
      exomesRead.has(chrom) ? (exomeHits.get(key) ?? null) : null,
      genomesRead.has(chrom) ? (genomeHits.get(key) ?? null) : null
    );
    frequencies.set(key, chosen ?? 0);
  }
  return frequencies;
}

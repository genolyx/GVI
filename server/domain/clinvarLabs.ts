import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { clinvarVcfPath } from "./variantIdentity";
import { gnomadSiteKey } from "./gnomadLocal";

const BENIGN_SUBMISSION = new Set(["benign", "likely benign"]);

/** Clinical laboratories whose Benign or Likely benign submission removes a variant. */
export function isMajorClinicalLab(submitter: string): boolean {
  const name = submitter.trim().toLowerCase();
  if (!name || name.includes("genomeconnect")) return false;
  if (name.includes("genedx")) return true;
  if (name.includes("invitae")) return true;
  if (name.includes("labcorp") || name.includes("laboratory corporation of america")) return true;
  if (name.includes("natera")) return true;
  if (name.includes("ambry genetics")) return true;
  if (name.includes("blueprint genetics")) return true;
  if (name.includes("preventiongenetics")) return true;
  if (name.includes("fulgent genetics")) return true;
  if (name === "baylor genetics" || name.startsWith("baylor genetics,")) return true;
  if (name === "medical genetics laboratories, baylor college of medicine") return true;
  return false;
}

/** True when this submission's own classification is Benign or Likely benign. */
export function isBenignOrLikelyBenignSubmission(value: string): boolean {
  const tokens = value
    .toLowerCase()
    .replaceAll("_", " ")
    .split(/[/|,;]+/)
    .map(token => token.trim())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every(token => BENIGN_SUBMISSION.has(token));
}

/** SCV005909190.1 and SCV005909190 are the same submission. */
export function scvAccession(value: string): string | null {
  const match = value.trim().toUpperCase().match(/SCV\d+/);
  return match ? match[0] : null;
}

export function submissionSummaryPath(): string {
  return path.join(path.dirname(clinvarVcfPath()), "submission_summary.txt.gz");
}

export function benignScvFromSubmissionLine(line: string): string | null {
  if (!line || line.startsWith("#")) return null;
  const columns = line.split("\t");
  if (columns.length < 11) return null;
  const scv = scvAccession(columns[10] ?? "");
  if (!scv || !isMajorClinicalLab(columns[9] ?? "") || !isBenignOrLikelyBenignSubmission(columns[1] ?? "")) {
    return null;
  }
  return scv;
}

export function benignScvsFromSubmissionLines(lines: Iterable<string>): Set<string> {
  const scvs = new Set<string>();
  for (const line of lines) {
    const scv = benignScvFromSubmissionLine(line);
    if (scv) scvs.add(scv);
  }
  return scvs;
}

export function clinvarSitesForBenignSubmissions(lines: Iterable<string>, benignScvs: ReadonlySet<string>): Set<string> {
  const sites = new Set<string>();
  if (!benignScvs.size) return sites;
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    if (columns.length < 8) continue;
    const [chromosome, positionRaw, , referenceAllele, alternateAllele, , , info] = columns;
    if (!chromosome || !referenceAllele || !alternateAllele || alternateAllele.includes(",")) continue;
    const position = Number(positionRaw);
    if (!Number.isInteger(position)) continue;
    const listed = info.match(/(?:^|;)CLNSIGSCV=([^;]*)/)?.[1];
    if (!listed || listed === ".") continue;
    const matched = listed.split("|").some(token => {
      const scv = scvAccession(token);
      return scv !== null && benignScvs.has(scv);
    });
    if (!matched) continue;
    sites.add(gnomadSiteKey({ chromosome, position, referenceAllele, alternateAllele }));
  }
  return sites;
}

function linesOf(file: string): AsyncIterable<string> {
  const input = createReadStream(file).pipe(createGunzip());
  return createInterface({ input, crlfDelay: Infinity });
}

export async function loadMajorLabBenignSitesFrom(summaryFile: string, clinvarFile: string): Promise<Set<string>> {
  const benignScvs = new Set<string>();
  for await (const line of linesOf(summaryFile)) {
    const scv = benignScvFromSubmissionLine(line);
    if (scv) benignScvs.add(scv);
  }
  const sites = new Set<string>();
  for await (const line of linesOf(clinvarFile)) {
    for (const site of clinvarSitesForBenignSubmissions([line], benignScvs)) sites.add(site);
  }
  return sites;
}

let cachedKey = "";
let cachedSites: ReadonlySet<string> | null = null;
let pending: Promise<ReadonlySet<string>> | null = null;

/** Sites a major laboratory called Benign or Likely benign. Empty when a source file is missing. */
export async function loadMajorLabBenignSites(): Promise<ReadonlySet<string>> {
  const summaryFile = submissionSummaryPath();
  const clinvarFile = clinvarVcfPath();
  let key = "";
  try {
    const [summaryStat, clinvarStat] = await Promise.all([stat(summaryFile), stat(clinvarFile)]);
    key = `${summaryStat.mtimeMs}:${summaryStat.size}:${clinvarStat.mtimeMs}:${clinvarStat.size}`;
  } catch {
    return new Set();
  }
  if (cachedSites && cachedKey === key) return cachedSites;
  if (!pending) {
    pending = loadMajorLabBenignSitesFrom(summaryFile, clinvarFile)
      .then(sites => {
        cachedKey = key;
        cachedSites = sites;
        pending = null;
        return sites;
      })
      .catch(error => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

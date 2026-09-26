import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";

export type ReferenceTrack = "G" | "S" | "tool";
export type ReferenceStatus = "ready" | "missing" | "remote" | "license" | "optional" | "downloading";

export type GnomadMode = "local" | "myvariant" | "v3.1.2" | "v4.1";
export type GnomadSelection = "myvariant" | "v3.1.2" | "v4.1";
export type ClinvarMode = "local" | "ncbi";

export type ReferenceLocalOption = {
  value: GnomadSelection;
  label: string;
  ready: boolean;
  location: string;
};

export type ReferenceSource = {
  id: string;
  name: string;
  track: ReferenceTrack;
  purpose: string;
  status: ReferenceStatus;
  version: string;
  detail: string;
  location: string;
  choice?: GnomadMode | ClinvarMode | GnomadSelection;
  localReady?: boolean;
  localVersion?: string | null;
  localOptions?: ReferenceLocalOption[];
  remoteChoice?: "myvariant" | "ncbi";
  remoteLabel?: string;
};

export type StoredPaper = {
  pmid: string | null;
  name: string;
  relativePath: string;
  bytes: number;
  savedAt: string;
};

export type ReferenceDataStatus = {
  dataRoot: string;
  pdfDir: string;
  sources: ReferenceSource[];
  papers: StoredPaper[];
  paperCount: number;
};

type EnvMap = Record<string, string>;

const PAPER_LIST_LIMIT = 300;

export function parsePmid(filename: string): string | null {
  const match = filename.match(/PMID[_-]?(\d+)/i);
  return match?.[1] ?? null;
}

export function parseClinvarFileDate(header: string): string | null {
  const match = header.match(/^##fileDate=(.+)$/m);
  return match?.[1]?.trim() || null;
}

export function parseHgmdRelease(filePath: string): string | null {
  const match = path.basename(filePath).match(/hgmd[_-]?(\d{4})[_-]?v(\d+)/i);
  if (!match) return null;
  return `${match[1]} V${match[2]}`;
}

export function parseGnomadRelease(name: string): string | null {
  const match = name.match(/\.v(\d+(?:\.\d+)*)/i);
  return match ? `v${match[1]}` : null;
}

export function parseClinvarMode(text: string): ClinvarMode | null {
  const value = text.trim().toLowerCase();
  if (value === "local" || value === "ncbi") return value;
  return null;
}

export function parseGnomadMode(text: string): GnomadMode | null {
  const value = text.trim().toLowerCase();
  if (value === "local" || value === "myvariant" || value === "v3.1.2" || value === "v4.1") return value;
  return null;
}

/** Installed releases the Settings menu can choose. v4 lives beside the v3 directory. */
export function gnomadReleaseDirectories(v3Dir: string): { release: GnomadSelection; label: string; dir: string }[] {
  const root = v3Dir.replace(/\/+$/, "");
  const v4 = root ? path.join(path.dirname(root), "gnomad4") : "";
  return [
    { release: "v3.1.2", label: "v3.1.2", dir: root },
    { release: "v4.1", label: "v4.1", dir: v4 },
  ];
}

export function gnomadModePath(dataRoot: string): string {
  return path.join(dataRoot, "gnomad-source");
}

export function parseClingenRelease(header: string): string | null {
  const match = header.match(/^#(\d{1,2}\s+[A-Za-z]+,?\s*\d{4})\s*$/m);
  return match?.[1]?.trim() || null;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseEnvFile(contents: string): EnvMap {
  const out: EnvMap = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

async function loadEnv(): Promise<EnvMap> {
  const merged: EnvMap = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(merged, parseEnvFile(await readFile(name, "utf8")));
    } catch {
      // Missing env files are normal in some runtimes.
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function hasValue(env: EnvMap, key: string): boolean {
  return Boolean((env[key] ?? "").trim());
}

async function fileInfo(filePath: string): Promise<{ exists: boolean; bytes: number; mtime: Date | null; partial: boolean }> {
  const partialPath = `${filePath}.partial`;
  try {
    const info = await stat(filePath);
    if (info.isFile() && info.size > 0) {
      return { exists: true, bytes: info.size, mtime: info.mtime, partial: false };
    }
  } catch {
    // Fall through to the in-progress download marker.
  }
  try {
    const partial = await stat(partialPath);
    if (partial.isFile()) return { exists: false, bytes: partial.size, mtime: partial.mtime, partial: true };
  } catch {
    // Neither file is present.
  }
  return { exists: false, bytes: 0, mtime: null, partial: false };
}

async function readHeader(filePath: string, maxLines: number): Promise<string> {
  const gunzip = filePath.endsWith(".gz");
  const stream = gunzip ? createReadStream(filePath).pipe(createGunzip()) : createReadStream(filePath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const collected: string[] = [];
  try {
    for await (const line of lines) {
      collected.push(line);
      if (collected.length >= maxLines) break;
    }
  } catch {
    return collected.join("\n");
  } finally {
    lines.close();
    stream.destroy();
  }
  return collected.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(date: Date | null): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

async function localFileSource(
  spec: {
    id: string;
    name: string;
    track: ReferenceTrack;
    purpose: string;
    relativePath: string;
    envKey?: string;
    versionFrom?: "clinvar" | "clingen" | "hgmd" | "mtime";
  },
  root: string,
  env: EnvMap
): Promise<ReferenceSource> {
  const override = spec.envKey ? (env[spec.envKey] ?? "").trim() : "";
  const location = override ? expandHome(override) : path.join(root, spec.relativePath);
  const info = await fileInfo(location);
  const base = { id: spec.id, name: spec.name, track: spec.track, purpose: spec.purpose, location };
  if (info.partial) {
    return {
      ...base,
      status: "downloading",
      version: "download in progress",
      detail: `${formatBytes(info.bytes)} received`,
    };
  }
  if (!info.exists) {
    return {
      ...base,
      status: "missing",
      version: "not installed",
      detail: "File is not on this server yet.",
    };
  }
  let version = `file dated ${formatWhen(info.mtime)}`;
  if (spec.versionFrom === "clinvar") {
    const header = await readHeader(location, 40);
    version = parseClinvarFileDate(header) ?? version;
  } else if (spec.versionFrom === "clingen") {
    const header = await readHeader(location, 8);
    version = parseClingenRelease(header) ?? version;
  } else if (spec.versionFrom === "hgmd") {
    version = parseHgmdRelease(location) ?? version;
  }
  return {
    ...base,
    status: "ready",
    version,
    detail: formatBytes(info.bytes),
  };
}

async function listPapers(pdfDir: string): Promise<{ papers: StoredPaper[]; paperCount: number }> {
  const papers: StoredPaper[] = [];
  let paperCount = 0;

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const pmid = parsePmid(entry.name);
      const looksLikeLiterature = Boolean(pmid) || /\.(pdf|txt|xlsx|xls|csv|tsv)$/i.test(entry.name);
      if (!looksLikeLiterature) continue;
      paperCount += 1;
      if (papers.length >= PAPER_LIST_LIMIT) continue;
      try {
        const info = await stat(full);
        papers.push({
          pmid,
          name: entry.name,
          relativePath: path.relative(pdfDir, full),
          bytes: info.size,
          savedAt: info.mtime.toISOString(),
        });
      } catch {
        // A file can disappear between listing and stat.
      }
    }
  }

  await walk(pdfDir);
  papers.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return { papers, paperCount };
}

async function indexedGnomadFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const present = new Set(names);
  return names.filter(name => {
    if (!/gnomad/i.test(name) || !/\.(?:vcf\.gz|vcf\.bgz|bgz)$/i.test(name)) return false;
    return present.has(`${name}.tbi`) || present.has(`${name}.csi`);
  });
}

async function readGnomadMode(dataRoot: string): Promise<GnomadMode | null> {
  try {
    return parseGnomadMode(await readFile(gnomadModePath(dataRoot), "utf8"));
  } catch {
    return null;
  }
}

async function indexedRelease(dir: string, file: string): Promise<{ ready: boolean; version: string | null; count: number; countLabel: string }> {
  let names: string[] = [];
  if (file) {
    const body = await fileInfo(file);
    const indexed = (await fileInfo(`${file}.tbi`)).exists || (await fileInfo(`${file}.csi`)).exists;
    names = body.exists && indexed ? [path.basename(file)] : [];
  } else if (dir) {
    names = await indexedGnomadFiles(dir);
  }
  const genomes = names.filter(name => /genomes/i.test(name)).length;
  const exomes = names.filter(name => /exomes/i.test(name)).length;
  const countLabel = [genomes ? `${genomes} genomes` : "", exomes ? `${exomes} exomes` : ""].filter(Boolean).join(" and ");
  return {
    ready: names.length > 0,
    version: names.map(parseGnomadRelease).find(Boolean) ?? null,
    count: names.length,
    countLabel,
  };
}

async function gnomadSource(env: EnvMap, dataRoot: string): Promise<ReferenceSource> {
  const v3Dir = expandHome((env.VC_GNOMAD_DIR ?? "").trim());
  const singleFile = expandHome((env.VC_GNOMAD_PATH ?? "").trim());
  const catalogs = gnomadReleaseDirectories(v3Dir);
  const base = {
    id: "gnomad",
    name: "gnomAD",
    track: "tool" as const,
    purpose: "Engine allele frequency (BA1, BS1, PM2)",
    remoteChoice: "myvariant" as const,
    remoteLabel: "MyVariant",
  };
  const options: ReferenceLocalOption[] = [];
  const installed = new Map<GnomadSelection, { ready: boolean; version: string | null; countLabel: string; location: string }>();
  for (const catalog of catalogs) {
    const useFile = catalog.release === "v3.1.2" ? singleFile : "";
    const info = await indexedRelease(useFile ? "" : catalog.dir, useFile);
    const location = useFile || catalog.dir;
    const label = info.version ?? catalog.label;
    options.push({ value: catalog.release, label, ready: info.ready, location });
    installed.set(catalog.release, { ...info, location });
  }
  const stored = await readGnomadMode(dataRoot);
  const choice: GnomadSelection = stored === "v3.1.2" || stored === "v4.1" || stored === "myvariant"
    ? stored
    : stored === "local" || options.some(option => option.ready)
      ? (options.find(option => option.ready)?.value ?? "myvariant")
      : "myvariant";
  const selected = choice === "myvariant" ? null : installed.get(choice);
  const anyReady = options.some(option => option.ready);
  const selectedDetail = selected?.ready
    ? `${selected.countLabel} indexed site VCF${selected.count === 1 ? "" : "s"} at ${selected.location}.`
    : selected
      ? `No indexed sites VCF is in ${selected.location}.`
      : "";
  if (choice === "myvariant") {
    return {
      ...base,
      status: "remote",
      version: "MyVariant",
      detail: `Frequency comes from MyVariant gnomad_exomes and gnomad_genomes. ${selectedDetail}`.trim(),
      location: "https://myvariant.info",
      choice,
      localReady: anyReady,
      localVersion: options.find(option => option.ready)?.label ?? null,
      localOptions: options,
    };
  }
  return {
    ...base,
    status: selected?.ready ? "ready" : "missing",
    version: selected?.version ?? selected?.location ?? "not installed",
    detail: selected?.ready
      ? `${selectedDetail} The engine reads INFO AF from these files.`
      : selectedDetail,
    location: selected?.location ?? "",
    choice,
    localReady: anyReady,
    localVersion: selected?.version ?? null,
    localOptions: options,
  };
}

async function decorateClinvar(clinvar: ReferenceSource, dataRoot: string): Promise<ReferenceSource> {
  const localReady = clinvar.status === "ready";
  const localVersion = localReady ? clinvar.version : null;
  const stored = await readStoredMode(dataRoot, "clinvar", parseClinvarMode);
  const choice: ClinvarMode = stored ?? (localReady ? "local" : "ncbi");
  const marked: ReferenceSource = {
    ...clinvar,
    choice,
    localReady,
    localVersion,
    remoteChoice: "ncbi",
    remoteLabel: "NCBI / MyVariant",
  };
  if (choice === "ncbi") {
    return {
      ...marked,
      purpose: "NCBI ClinVar and MyVariant",
      status: "remote",
      version: "NCBI / MyVariant",
      detail: localReady
        ? `Queried from NCBI ClinVar and MyVariant. Local file ${localVersion} is installed.`
        : "Queried from NCBI ClinVar and MyVariant.",
      location: "https://eutils.ncbi.nlm.nih.gov",
    };
  }
  return {
    ...marked,
    purpose: "Local ClinVar VCF",
    detail: localReady
      ? `${clinvar.detail}. The engine reads CLNSIG and the variation ID from this VCF.`
      : clinvar.detail,
  };
}

async function readStoredMode<T extends string>(
  dataRoot: string,
  stem: string,
  parse: (text: string) => T | null,
): Promise<T | null> {
  try {
    return parse(await readFile(path.join(dataRoot, `${stem}-source`), "utf8"));
  } catch {
    return null;
  }
}

async function writeSourceFile(dataRoot: string, stem: string, mode: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, `${stem}-source`), `${mode}\n`, "utf8");
}

export async function setClinvarSource(mode: ClinvarMode): Promise<void> {
  const env = await loadEnv();
  const dataRoot = expandHome((env.VC_DATA_ROOT ?? "").trim() || path.join(os.homedir(), "gvi-data"));
  if (mode === "local") {
    const override = expandHome((env.VC_CLINVAR_PATH ?? "").trim());
    const file = override || path.join(dataRoot, "reference", "clinvar", "clinvar.vcf.gz");
    const body = await fileInfo(file);
    const indexed = (await fileInfo(`${file}.tbi`)).exists || (await fileInfo(`${file}.csi`)).exists;
    if (!body.exists || !indexed) {
      throw new Error("No indexed ClinVar VCF is configured.");
    }
  }
  await writeSourceFile(dataRoot, "clinvar", mode);
}

export async function setGnomadSource(mode: GnomadSelection): Promise<void> {
  const env = await loadEnv();
  const dataRoot = expandHome((env.VC_DATA_ROOT ?? "").trim() || path.join(os.homedir(), "gvi-data"));
  if (mode !== "myvariant") {
    const preview = await gnomadSource(env, dataRoot);
    const option = preview.localOptions?.find(item => item.value === mode);
    if (!option?.ready) {
      throw new Error(`No indexed gnomAD ${mode} sites VCF is installed.`);
    }
  }
  await mkdir(dataRoot, { recursive: true });
  await writeFile(gnomadModePath(dataRoot), `${mode}\n`, "utf8");
}

export async function inspectReferenceData(): Promise<ReferenceDataStatus> {
  const env = await loadEnv();
  const dataRoot = expandHome((env.VC_DATA_ROOT ?? "").trim() || path.join(os.homedir(), "gvi-data"));
  const pdfDir = expandHome((env.VC_PDF_DIR ?? "").trim() || path.join(dataRoot, "pdfs"));
  const hgmdEnabled = (env.ENGINE_HGMD_ENABLED ?? "true").trim().toLowerCase() !== "false";

  const clinvar = await localFileSource(
    {
      id: "clinvar",
      name: "ClinVar GRCh38 VCF + TBI",
      track: "G",
      purpose: "Engine tabix and NCBI/MyVariant cross-check",
      relativePath: "reference/clinvar/clinvar.vcf.gz",
      envKey: "VC_CLINVAR_PATH",
      versionFrom: "clinvar",
    },
    dataRoot,
    env
  );
  const clinvarTbi = await fileInfo(`${clinvar.location}.tbi`);
  if (clinvar.status === "ready" && !clinvarTbi.exists) {
    clinvar.status = "missing";
    clinvar.version = `${clinvar.version} (index missing)`;
    clinvar.detail = "VCF is present, but clinvar.vcf.gz.tbi is not.";
  }
  const clinvarChoice = await decorateClinvar(clinvar, dataRoot);

  const clingen = await localFileSource(
    {
      id: "clingen",
      name: "ClinGen gene curation TSV",
      track: "G",
      purpose: "Engine haploinsufficiency score (PVS1)",
      relativePath: "reference/clingen/ClinGen_gene_curation_list_GRCh38.tsv",
      envKey: "VC_CLINGEN_PATH",
      versionFrom: "clingen",
    },
    dataRoot,
    env
  );

  const hgmdFile = await localFileSource(
    {
      id: "hgmd",
      name: "HGMD Professional",
      track: "G",
      purpose: "Engine spreadsheet mount",
      relativePath: "reference/hgmd/HGMD_2025_V4_hg38.xltx",
      envKey: "VC_HGMD_PATH",
      versionFrom: "hgmd",
    },
    dataRoot,
    env
  );
  const hgmd: ReferenceSource = !hgmdEnabled
    ? { ...hgmdFile, status: "license", version: "disabled", detail: "ENGINE_HGMD_ENABLED=false. The commercial file is not mounted." }
    : hgmdFile.status === "ready"
      ? hgmdFile
      : { ...hgmdFile, status: "license", version: "not installed", detail: "QIAGEN license file is required. There is no public download." };

  const chain = await localFileSource(
    {
      id: "chain",
      name: "chain (GRCh37 to GRCh38)",
      track: "tool",
      purpose: "GVI liftover",
      relativePath: "reference/liftover/hg19ToHg38.over.chain.gz",
      versionFrom: "mtime",
    },
    dataRoot,
    env
  );

  const sources: ReferenceSource[] = [
    clinvarChoice,
    clingen,
    hgmd,
    await gnomadSource(env, dataRoot),
    {
      id: "omim",
      name: "OMIM",
      track: "G",
      purpose: "Links only. No automatic ingest.",
      status: "license",
      version: "registration",
      detail: "OMIM downloads require a registered license. GVI does not store a local copy.",
      location: "https://omim.org/downloads",
    },
    {
      id: "ncbi-eutils",
      name: "NCBI PubMed / ClinVar eutils",
      track: "G",
      purpose: "Literature search and ClinVar summaries",
      status: "remote",
      version: hasValue(env, "NCBI_API_KEY") ? "live, API key set" : "live, anonymous (~3 req/s)",
      detail: "Called at curation time. Saved papers are listed below.",
      location: "https://eutils.ncbi.nlm.nih.gov",
    },
    {
      id: "europe-pmc",
      name: "Europe PMC",
      track: "G",
      purpose: "Engine literature search and OA PDFs",
      status: "remote",
      version: "live",
      detail: "No local database. Open-access PDFs are stored under the literature folder when a curation run downloads them.",
      location: "https://www.ebi.ac.uk/europepmc/webservices/rest",
    },
    {
      id: "gene-reviews",
      name: "GeneReviews",
      track: "G",
      purpose: "Engine gene-profile links",
      status: "remote",
      version: "live",
      detail: "Linked from NCBI Bookshelf. No local copy.",
      location: "https://www.ncbi.nlm.nih.gov/books/NBK1116",
    },
    {
      id: "ensembl",
      name: "Ensembl REST / VEP",
      track: "G",
      purpose: "Transcripts, CDS, VEP, NMD",
      status: "remote",
      version: "GRCh38 live",
      detail: "Called at curation time. No local copy.",
      location: "https://rest.ensembl.org",
    },
    {
      id: "myvariant",
      name: "MyVariant.info",
      track: "G",
      purpose: "Engine in-silico ClinVar cross-check",
      status: "remote",
      version: "live",
      detail: "Called at curation time. No local copy.",
      location: "https://myvariant.info",
    },
    {
      id: "spliceai",
      name: "Broad SpliceAI / Pangolin",
      track: "G",
      purpose: "Engine splice scores",
      status: "remote",
      version: "live API",
      detail: "Scores come from the Broad/Illumina API. Local score files are optional.",
      location: "https://spliceailookup-api.broadinstitute.org",
    },
    {
      id: "metadome",
      name: "MetaDome",
      track: "G",
      purpose: "Engine domain tolerance",
      status: "remote",
      version: "live",
      detail: "Called at curation time. No local copy.",
      location: "https://stuart.radboudumc.nl/metadome",
    },
    {
      id: "uniprot",
      name: "UniProt",
      track: "G",
      purpose: "Engine protein domains",
      status: "remote",
      version: "live",
      detail: "Called at curation time. No local copy.",
      location: "https://rest.uniprot.org",
    },
    {
      id: "ucsc",
      name: "UCSC sequence",
      track: "G",
      purpose: "Sequence fallback when Ensembl has no sequence",
      status: "remote",
      version: "live",
      detail: "Called at curation time. No local copy.",
      location: "https://api.genome.ucsc.edu",
    },
    {
      id: "civic",
      name: "CIViC",
      track: "S",
      purpose: "GVI AMP evidence, queried live",
      status: "remote",
      version: hasValue(env, "CIVIC_API_KEY") ? "live, API key set" : "live, anonymous",
      detail: "Nightly snapshot ingest is not enabled. Evidence is fetched from the GraphQL API.",
      location: "https://civicdb.org/api/graphql",
    },
    {
      id: "oncokb",
      name: "OncoKB",
      track: "S",
      purpose: "GVI AMP tier and oncogenicity",
      status: hasValue(env, "ONCOKB_TOKEN") ? "remote" : "missing",
      version: hasValue(env, "ONCOKB_TOKEN") ? "annotate API, token set" : "token required",
      detail: hasValue(env, "ONCOKB_TOKEN")
        ? "Annotate calls use the configured academic or commercial token."
        : "Set ONCOKB_TOKEN. Without it, AMP evidence still runs on CIViC and population AF.",
      location: "https://www.oncokb.org/api/v1",
    },
    {
      id: "grch38",
      name: "GRCh38 reference",
      track: "tool",
      purpose: "Normalization and liftover target",
      status: "optional",
      version: "coordinates only",
      detail: "GVI stores variant coordinates. A local FASTA is not mounted.",
      location: dataRoot,
    },
    chain,
  ];

  const literature = await listPapers(pdfDir);
  return { dataRoot, pdfDir, sources, papers: literature.papers, paperCount: literature.paperCount };
}

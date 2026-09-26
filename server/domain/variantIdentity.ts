import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type VariantIdentityHit = {
  rsid: string | null;
  hgvsG: string | null;
  source: "clinvar" | "myvariant" | "ensembl" | null;
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function clinvarVcfPath(): string {
  const override = (process.env.VC_CLINVAR_PATH || "").trim();
  if (override) return expandHome(override);
  const root = expandHome((process.env.VC_DATA_ROOT || "").trim() || path.join(os.homedir(), "gvi-data"));
  return path.join(root, "reference", "clinvar", "clinvar.vcf.gz");
}

export function clinvarContig(chrom: string): string | null {
  const nc = chrom.trim().match(/^NC_0*(\d+)\.\d+$/i);
  if (nc) {
    const n = Number(nc[1]);
    if (n >= 1 && n <= 22) return String(n);
    if (n === 23) return "X";
    if (n === 24) return "Y";
    return null;
  }
  const bare = chrom.trim().replace(/^chr/i, "");
  if (/^(?:[1-9]|1\d|2[0-2]|X|Y|M|MT)$/i.test(bare)) return bare.toUpperCase() === "MT" ? "M" : bare.toUpperCase();
  return null;
}

export function normalizeRsid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.split(/[|,]/)[0]?.trim() ?? "";
  if (!token || token === ".") return null;
  if (/^rs\d+$/i.test(token)) return `rs${token.slice(2)}`;
  if (/^\d+$/.test(token)) return `rs${token}`;
  return null;
}

export function matchClinvarRecords(text: string, ref: string, alt: string): { rsid: string | null; hgvsG: string | null } | null {
  const wantRef = ref.trim().toUpperCase();
  const wantAlt = alt.trim().toUpperCase();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [rowRef = "", rowAlt = "", rs = "", hgvs = ""] = line.split("\t");
    if (rowRef.toUpperCase() !== wantRef || rowAlt.toUpperCase() !== wantAlt) continue;
    const hgvsG = hgvs.split(",").map(item => item.trim()).find(item => item.includes(":g.")) ?? null;
    return { rsid: normalizeRsid(rs), hgvsG };
  }
  return null;
}

export function rsidFromMyvariant(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const dbsnp = (body as { dbsnp?: { rsid?: unknown } }).dbsnp;
  return typeof dbsnp?.rsid === "string" ? normalizeRsid(dbsnp.rsid) : null;
}

export function rsidFromEnsembl(body: unknown, start: number): string | null {
  if (!Array.isArray(body)) return null;
  const colocated = body[0]?.colocated_variants;
  if (!Array.isArray(colocated)) return null;
  const hit = colocated.find((item: { id?: string; start?: number }) =>
    typeof item?.id === "string" && /^rs\d+$/.test(item.id) && (item.start == null || item.start === start));
  return hit ? normalizeRsid(hit.id) : null;
}

async function clinvarHit(chrom: string, pos: number, ref: string, alt: string): Promise<{ rsid: string | null; hgvsG: string | null } | null> {
  const contig = clinvarContig(chrom);
  if (!contig) return null;
  const file = clinvarVcfPath();
  try {
    await access(file);
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      "bcftools",
      ["query", "-f", "%REF\t%ALT\t%INFO/RS\t%INFO/CLNHGVS\n", "-r", `${contig}:${pos}-${pos}`, file],
      { timeout: 8000 },
    );
    return matchClinvarRecords(stdout, ref, alt);
  } catch {
    return null;
  }
}

async function readJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function myvariantRsid(chrom: string, pos: number, ref: string, alt: string): Promise<string | null> {
  if (ref.length !== 1 || alt.length !== 1) return null;
  const contig = clinvarContig(chrom);
  if (!contig) return null;
  const id = `chr${contig}:g.${pos}${ref.toUpperCase()}>${alt.toUpperCase()}`;
  const body = await readJson(`https://myvariant.info/v1/variant/${encodeURIComponent(id)}?fields=dbsnp.rsid&assembly=hg38`);
  return rsidFromMyvariant(body);
}

async function ensemblRsid(chrom: string, pos: number, alt: string): Promise<string | null> {
  if (alt.length !== 1) return null;
  const contig = clinvarContig(chrom);
  if (!contig) return null;
  const region = `${contig}:${pos}-${pos}:1/${encodeURIComponent(alt.toUpperCase())}`;
  const body = await readJson(`https://rest.ensembl.org/vep/human/region/${region}?content-type=application/json`);
  return rsidFromEnsembl(body, pos);
}

export async function lookupVariantIdentity(chrom: string, pos: number, ref: string, alt: string): Promise<VariantIdentityHit> {
  const clinvar = await clinvarHit(chrom, pos, ref, alt);
  if (clinvar?.rsid) return { rsid: clinvar.rsid, hgvsG: clinvar.hgvsG, source: "clinvar" };
  const fromMyvariant = await myvariantRsid(chrom, pos, ref, alt);
  if (fromMyvariant) return { rsid: fromMyvariant, hgvsG: clinvar?.hgvsG ?? null, source: "myvariant" };
  const fromEnsembl = await ensemblRsid(chrom, pos, alt);
  if (fromEnsembl) return { rsid: fromEnsembl, hgvsG: clinvar?.hgvsG ?? null, source: "ensembl" };
  return { rsid: null, hgvsG: clinvar?.hgvsG ?? null, source: clinvar?.hgvsG ? "clinvar" : null };
}

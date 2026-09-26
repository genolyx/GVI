const COMPLEMENT: Record<string, string> = { A: "T", T: "A", C: "G", G: "C", a: "t", t: "a", c: "g", g: "c" };

export type GenomicVariant = {
  chromosome?: string | null;
  start?: number | null;
  end?: number | null;
  referenceAllele?: string | null;
  alternateAllele?: string | null;
  strand?: number | null;
};

export type GenomicIdentity = {
  hgvsG: string | null;
  rsid: string | null;
  lookup: { chrom: string; start: number; end: number; ref: string; alt: string } | null;
};

function revcomp(seq: string): string {
  return [...seq].reverse().map(base => COMPLEMENT[base] ?? base).join("");
}

function withChr(chrom: string): string {
  return chrom.toLowerCase().startsWith("chr") ? chrom : `chr${chrom}`;
}

function formatHgvsG(chrom: string, start: number, end: number, ref: string, alt: string): string | null {
  const refU = ref.trim().toUpperCase();
  const altU = alt.trim().toUpperCase();
  if (!chrom || !start || !refU || !altU) return null;
  let body: string;
  if (refU.length === 1 && altU.length === 1) body = `${start}${refU}>${altU}`;
  else if (altU === "-") body = start === end ? `${start}del` : `${start}_${end}del`;
  else if (refU === "-") body = `${start}_${start + 1}ins${altU}`;
  else body = `${start}_${end}delins${altU}`;
  return `${withChr(chrom)}:g.${body}`;
}

function fromVcf(vcf: unknown): { hgvsG: string; lookup: GenomicIdentity["lookup"] } | null {
  if (typeof vcf !== "string") return null;
  const [chrom, pos, ref, alt] = vcf.split("-");
  const start = Number(pos);
  if (!chrom || !Number.isFinite(start) || !ref || !alt) return null;
  const hgvsG = formatHgvsG(chrom, start, start, ref, alt);
  if (!hgvsG) return null;
  const altU = alt.trim().toUpperCase();
  const refU = ref.trim().toUpperCase();
  return {
    hgvsG,
    lookup: { chrom: withChr(chrom), start, end: start, ref: refU, alt: altU },
  };
}

export function genomicIdentity(variant: GenomicVariant | null | undefined, parsed: Record<string, unknown> | null | undefined): GenomicIdentity {
  const storedRs = typeof parsed?.rsid === "string" && /^rs\d+$/.test(parsed.rsid) ? parsed.rsid : null;
  const storedG = typeof parsed?.hgvs_g === "string" && parsed.hgvs_g.includes(":g.") ? parsed.hgvs_g : null;
  if (storedG) {
    const snv = storedG.match(/:g\.(\d+)([ACGT])>([ACGT])$/i);
    return {
      hgvsG: storedG,
      rsid: storedRs,
      lookup: snv ? { chrom: storedG.split(":")[0], start: Number(snv[1]), end: Number(snv[1]), ref: snv[2].toUpperCase(), alt: snv[3].toUpperCase() } : null,
    };
  }
  const vcf = fromVcf(parsed?.vep_vcf_string);
  if (vcf) return { hgvsG: vcf.hgvsG, rsid: storedRs, lookup: vcf.lookup };

  const chrom = variant?.chromosome ?? "";
  const start = variant?.start ?? 0;
  const end = variant?.end || start;
  let ref = variant?.referenceAllele ?? "";
  let alt = variant?.alternateAllele ?? "";
  const forward = parsed?.alleles_are_forward === true;
  if (!forward && variant?.strand === -1 && ref.length === 1 && alt.length === 1) {
    ref = revcomp(ref);
    alt = revcomp(alt);
  }
  const hgvsG = formatHgvsG(chrom, start, end, ref, alt);
  const refU = ref.trim().toUpperCase();
  const altU = alt.trim().toUpperCase();
  return {
    hgvsG,
    rsid: storedRs,
    lookup: hgvsG ? { chrom: withChr(chrom), start, end, ref: refU, alt: altU } : null,
  };
}

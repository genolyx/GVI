type ParsedInfo = Record<string, string | true>;

export type ParsedVariant = {
  normalizedId: string;
  referenceBuild: "GRCh37" | "GRCh38";
  chromosome: string;
  position: number;
  referenceAllele: string;
  alternateAllele: string;
  gene: string | null;
  transcript: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  consequence: string | null;
  variantType: "SNV" | "INDEL" | "CNV" | "SV" | "FUSION" | "OTHER";
  zygosity: string | null;
  populationAf: string | null;
  vaf: string | null;
  readDepth: number | null;
  alternateDepth: number | null;
  impact: "HIGH" | "MODERATE" | "LOW" | "MODIFIER" | "UNKNOWN";
  clinvarSignificance: string | null;
  annotation: Record<string, unknown>;
};

function parseInfo(raw: string): ParsedInfo {
  const result: ParsedInfo = {};
  for (const token of raw.split(";")) {
    if (!token) continue;
    const separator = token.indexOf("=");
    if (separator === -1) result[token] = true;
    else result[token.slice(0, separator)] = decodeURIComponent(token.slice(separator + 1));
  }
  return result;
}

function asNumber(value: string | true | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value.split(",")[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function variantType(ref: string, alt: string): ParsedVariant["variantType"] {
  if (alt.startsWith("<") || alt.includes("[") || alt.includes("]")) return "SV";
  if (ref.length === 1 && alt.length === 1) return "SNV";
  if (ref.length !== alt.length) return "INDEL";
  return "OTHER";
}

function parseSnpEff(info: ParsedInfo) {
  const ann = typeof info.ANN === "string" ? info.ANN.split(",")[0]?.split("|") : null;
  return ann
    ? {
        consequence: ann[1] || null,
        impact: ann[2] || "UNKNOWN",
        gene: ann[3] || null,
        transcript: ann[6] || null,
        hgvsC: ann[9] || null,
        hgvsP: ann[10] || null,
      }
    : null;
}

export function parseVcf(
  text: string,
  referenceBuild: "GRCh37" | "GRCh38",
  maxRecords = 50_000
): ParsedVariant[] {
  const records: ParsedVariant[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    if (columns.length < 8) continue;
    const [chromRaw, posRaw, id, ref, altRaw, quality, filter, infoRaw, format, sample] = columns;
    const position = Number(posRaw);
    if (!Number.isInteger(position) || !ref || !altRaw) continue;
    const chromosome = chromRaw.replace(/^chr/i, "");
    const info = parseInfo(infoRaw);
    const snpEff = parseSnpEff(info);
    const formatKeys = format?.split(":") || [];
    const sampleValues = sample?.split(":") || [];
    const sampleMap = Object.fromEntries(formatKeys.map((key, index) => [key, sampleValues[index]]));
    const depth = Number(sampleMap.DP || info.DP);
    const alleleDepths = sampleMap.AD?.split(",").map(Number) || [];
    const populationAf = asNumber(info.gnomAD_AF ?? info.POP_AF ?? info.AF);

    const alternateAlleles = altRaw.split(",");
    for (let altIndex = 0; altIndex < alternateAlleles.length; altIndex += 1) {
      const alt = alternateAlleles[altIndex];
      const alternateDepth = Number.isFinite(alleleDepths[altIndex + 1])
        ? alleleDepths[altIndex + 1]
        : null;
      const sampleAf = sampleMap.AF?.split(",")[altIndex];
      const vaf = sampleAf
        ? Number(sampleAf)
        : alternateDepth !== null && Number.isFinite(depth) && depth > 0
          ? alternateDepth / depth
          : null;
      const impactValue = String(snpEff?.impact || info.IMPACT || "UNKNOWN").toUpperCase();
      const impact = ["HIGH", "MODERATE", "LOW", "MODIFIER"].includes(impactValue)
        ? (impactValue as ParsedVariant["impact"])
        : "UNKNOWN";
      const gene = snpEff?.gene || (typeof info.GENE === "string" ? info.GENE : null) ||
        (typeof info.SYMBOL === "string" ? info.SYMBOL : null);

      records.push({
        normalizedId: `${referenceBuild}:${chromosome}:${position}:${ref}:${alt}`,
        referenceBuild,
        chromosome,
        position,
        referenceAllele: ref,
        alternateAllele: alt,
        gene,
        transcript: snpEff?.transcript || (typeof info.TRANSCRIPT === "string" ? info.TRANSCRIPT : null),
        hgvsC: snpEff?.hgvsC || (typeof info.HGVSC === "string" ? info.HGVSC : null),
        hgvsP: snpEff?.hgvsP || (typeof info.HGVSP === "string" ? info.HGVSP : null),
        consequence: snpEff?.consequence || (typeof info.CONSEQUENCE === "string" ? info.CONSEQUENCE : null),
        variantType: variantType(ref, alt),
        zygosity: sampleMap.GT || null,
        populationAf: populationAf === null ? null : String(populationAf),
        vaf: vaf === null || !Number.isFinite(vaf) ? null : String(vaf),
        readDepth: Number.isFinite(depth) ? depth : null,
        alternateDepth,
        impact,
        clinvarSignificance:
          typeof info.CLNSIG === "string" ? info.CLNSIG.replaceAll("_", " ") : null,
        annotation: { id, quality, filter, info },
      });
      if (records.length >= maxRecords) return records;
    }
  }
  return records;
}

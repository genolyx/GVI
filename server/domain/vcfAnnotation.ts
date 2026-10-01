import { maneRefseqForGene } from "./maneRefseq";

/** How an uploaded VCF should enter the annotation step. */

export type AnnotationSource = "vep" | "snpeff";

export type VcfAnnotationInspection =
  | {
      action: "skip";
      source: AnnotationSource;
      fields: string[];
      columns: string[];
    }
  | {
      action: "reject";
      source: AnnotationSource;
      fields: string[];
      missing: string[];
    }
  | { action: "annotate"; source: null; fields: [] };

const VEP_REQUIRED = ["SYMBOL", "Consequence", "IMPACT"] as const;
const VEP_FREQUENCY = ["gnomADe_AF", "gnomADg_AF", "gnomAD_AF"] as const;
const SNPEFF_GENE = ["Gene_Name", "Gene"] as const;
const SNPEFF_REQUIRED = ["Annotation", "Annotation_Impact"] as const;

function formatFields(headerLine: string): string[] {
  const marker = headerLine.toLowerCase().indexOf("format:");
  if (marker < 0) return [];
  let tail = headerLine.slice(marker + "format:".length).trim();
  if (tail.startsWith('"')) tail = tail.slice(1);
  const end = tail.indexOf('"');
  if (end >= 0) tail = tail.slice(0, end);
  return tail
    .split("|")
    .map(field => field.trim())
    .filter(Boolean);
}

function hasField(fields: string[], name: string) {
  const target = name.toLowerCase();
  return fields.some(field => field.toLowerCase() === target);
}

function headerInfo(text: string, id: "CSQ" | "ANN"): string[] | null {
  const prefix = `##INFO=<ID=${id}`;
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.startsWith("#")) break;
    if (line.startsWith(prefix)) return formatFields(line);
    start = end + 1;
  }
  return null;
}

function inspectFields(
  source: AnnotationSource,
  fields: string[]
): VcfAnnotationInspection {
  if (source === "vep") {
    const missing = VEP_REQUIRED.filter(name => !hasField(fields, name));
    if (!VEP_FREQUENCY.some(name => hasField(fields, name))) {
      missing.push("gnomADe_AF or gnomADg_AF");
    }
    if (missing.length) return { action: "reject", source, fields, missing: [...missing] };
    const columns = [
      ...VEP_REQUIRED.filter(name => hasField(fields, name)),
      ...VEP_FREQUENCY.filter(name => hasField(fields, name)),
    ];
    return { action: "skip", source, fields, columns };
  }
  const missing: string[] = [];
  if (!SNPEFF_GENE.some(name => hasField(fields, name))) missing.push("Gene_Name");
  for (const name of SNPEFF_REQUIRED) {
    if (!hasField(fields, name)) missing.push(name);
  }
  if (missing.length) return { action: "reject", source, fields, missing };
  const columns = [
    ...SNPEFF_GENE.filter(name => hasField(fields, name)),
    ...SNPEFF_REQUIRED,
  ];
  return { action: "skip", source, fields, columns };
}

/**
 * A VEP `CSQ` or snpEff `ANN` header means the file is already annotated.
 * Raw caller VCFs have neither, so they need the annotation step.
 * An annotated header that lacks the columns GVI filters on is rejected
 * instead of being annotated again.
 */
export function inspectVcfAnnotation(text: string): VcfAnnotationInspection {
  const csq = headerInfo(text, "CSQ");
  if (csq) return inspectFields("vep", csq);
  const ann = headerInfo(text, "ANN");
  if (ann) return inspectFields("snpeff", ann);
  return { action: "annotate", source: null, fields: [] };
}

export type ParsedFunctionalAnnotation = {
  gene: string | null;
  transcript: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  consequence: string | null;
  impact: string | null;
  populationAf: number | null;
  clinvar: string | null;
};

function named(fields: string[], row: string[], name: string) {
  const index = fields.findIndex(field => field.toLowerCase() === name.toLowerCase());
  if (index < 0) return "";
  return (row[index] ?? "").trim();
}

function highestFrequency(values: string[]) {
  const numbers = values
    .filter(value => value !== "" && value !== ".")
    .map(Number)
    .filter(value => Number.isFinite(value));
  if (!numbers.length) return null;
  return Math.max(...numbers);
}

/** RefSeq accession from a VEP MANE field. VEP may append a protein id after `|`. */
export function refseqAccession(value: string): string | null {
  const token = value.split(/[|&]/)[0]?.trim() ?? "";
  const match = /^NM_\d+(?:\.\d+)?/i.exec(token);
  return match ? match[0] : null;
}

/**
 * Clinical transcript, matching Service Portal's Transcript (NM) column.
 * MANE Select RefSeq wins, then MANE Plus Clinical, then a Feature that is already NM_.
 * An Ensembl Feature is kept only when no RefSeq accession is present.
 */
export function clinicalTranscript(fields: string[], row: string[], featureName: string): string | null {
  const mane =
    refseqAccession(named(fields, row, "MANE_SELECT")) ||
    refseqAccession(named(fields, row, "MANE_PLUS_CLINICAL"));
  if (mane) return mane;
  const feature = named(fields, row, featureName);
  return refseqAccession(feature) || feature || null;
}

/** HGVSc/HGVSp without the transcript prefix (`ENST…:c.` or `NM_…:c.` → `c.`). */
export function codingChange(hgvs: string): string | null {
  if (!hgvs) return null;
  const colon = hgvs.lastIndexOf(":");
  if (colon > 0) {
    const change = hgvs.slice(colon + 1);
    if (/^[cnpg]\./i.test(change)) return change;
  }
  return hgvs;
}

function pickRow(fields: string[], rows: string[][], alt: string) {
  const alleleRows = rows.filter(row => named(fields, row, "Allele") === alt);
  const pool = alleleRows.length ? alleleRows : rows;
  return (
    pool.find(row => named(fields, row, "MANE_SELECT")) ||
    pool.find(row => named(fields, row, "CANONICAL").toUpperCase() === "YES") ||
    pool[0] ||
    null
  );
}

/** Read gene, consequence, and gnomAD AF from one INFO CSQ or ANN value. */
export function annotationFromInfo(
  source: AnnotationSource,
  fields: string[],
  infoValue: string | true | undefined,
  alt: string
): ParsedFunctionalAnnotation | null {
  if (typeof infoValue !== "string" || !infoValue || fields.length === 0) return null;
  const rows = infoValue.split(",").map(entry => entry.split("|"));
  const picked = pickRow(fields, rows, alt);
  if (!picked) return null;
  const parsed =
    source === "vep"
      ? {
          gene: named(fields, picked, "SYMBOL") || null,
          transcript: clinicalTranscript(fields, picked, "Feature"),
          hgvsC: codingChange(named(fields, picked, "HGVSc")),
          hgvsP: codingChange(named(fields, picked, "HGVSp")),
          consequence: named(fields, picked, "Consequence") || null,
          impact: named(fields, picked, "IMPACT") || null,
          populationAf: highestFrequency([
            named(fields, picked, "gnomADe_AF"),
            named(fields, picked, "gnomADg_AF"),
            named(fields, picked, "gnomAD_AF"),
          ]),
          clinvar: named(fields, picked, "CLIN_SIG").replaceAll("_", " ") || null,
        }
      : {
          gene: named(fields, picked, "Gene_Name") || named(fields, picked, "Gene") || null,
          transcript: clinicalTranscript(fields, picked, "Feature_ID"),
          hgvsC: codingChange(named(fields, picked, "HGVS.c") || named(fields, picked, "HGVSc")),
          hgvsP: codingChange(named(fields, picked, "HGVS.p") || named(fields, picked, "HGVSp")),
          consequence: named(fields, picked, "Annotation") || null,
          impact: named(fields, picked, "Annotation_Impact") || null,
          populationAf: null,
          clinvar: null,
        };
  if (!parsed.transcript || !/^NM_/i.test(parsed.transcript)) {
    const mane = maneRefseqForGene(parsed.gene);
    if (mane) parsed.transcript = mane;
  }
  return parsed;
}

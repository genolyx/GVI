import type { CurationDocument } from "../../shared/curation/document";
import { clinvarRecordAt, reverseComplementAllele, type ClinvarRecordLookup } from "./clinvarAllele";
import { alignStoredIndel } from "./forwardAllele";

/** HGVS search for this transcript, so a bare c. change cannot open another isoform. */
export function clinvarAlleleSearchUrl(gene: string, transcript: string, change: string): string {
  const hgvs = change.trim();
  if (!hgvs) return "";
  const tx = transcript.trim();
  const symbol = gene.trim();
  const term = tx && symbol ? `${tx}(${symbol}):${hgvs}` : tx ? `${tx}:${hgvs}` : symbol ? `${symbol}[gene] AND ${hgvs}` : hgvs;
  return `https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent(term)}`;
}

function rewriteThisVariantLine(text: string, variationId: string): string {
  if (!text.includes(variationId)) return text;
  return text.replace(
    new RegExp(
      `This variant\\s*[—–-][\\s\\S]*?ClinVar\\s*${variationId}[\\s\\S]*?(?:</a>\\)|\\))`,
      "i"
    ),
    "This variant is not in ClinVar."
  );
}

/**
 * Drop a saved ClinVar call when that variation is not this genomic allele.
 * A nearby or spanning record must not stay on the review as this variant.
 */
export function withoutUnmatchedClinvar<T extends CurationDocument>(
  document: T,
  matchedVariationId: string | null
): T {
  const parsed = document.engine.parsedData;
  const claimed = String(parsed.clinvar_rcv ?? "").trim();
  if (!/^\d+$/.test(claimed) || claimed === matchedVariationId) return document;

  const gene = document.variant.gene || "";
  const transcript = String(parsed.transcript || document.variant.transcript || "");
  const change = String(parsed.c_dot || document.variant.hgvsC || "");
  const search = clinvarAlleleSearchUrl(gene, transcript, change);
  const logic = typeof parsed.logic_explanation === "string" ? parsed.logic_explanation : "";
  const plain = typeof parsed.logic_explanation_plaintext === "string" ? parsed.logic_explanation_plaintext : "";

  return {
    ...document,
    highlights: {
      ...document.highlights,
      clinvarSignificance: null,
      clinvarIdenticalPathogenic: false,
    },
    engine: {
      ...document.engine,
      parsedData: {
        ...parsed,
        clinvar_rcv: "",
        clinvar_sig: "Not found in public databases",
        ...(search ? { clinvar_search_link: search } : {}),
        ...(logic ? { logic_explanation: rewriteThisVariantLine(logic, claimed) } : {}),
        ...(plain ? { logic_explanation_plaintext: rewriteThisVariantLine(plain, claimed) } : {}),
      },
    },
  };
}

/** Replace the saved "This variant — …" call with the allele-matched ClinVar calls. */
export function replaceThisVariantSignificance(text: string, variationId: string, significance: string): string {
  if (!text || !variationId || !significance || !text.includes(variationId)) return text;
  return text.replace(
    new RegExp(
      `(This variant\\s*[—–-]\\s*)[\\s\\S]*?(?=\\s*(?:<a\\b|\\(\\s*<a\\b|\\(\\s*ClinVar\\s+${variationId}\\b))`,
      "gi"
    ),
    `$1${significance}`
  );
}

function withMatchedClinvarSignificance<T extends CurationDocument>(document: T, significance: string): T {
  const parsed = document.engine.parsedData;
  const variationId = String(parsed.clinvar_rcv ?? "").trim();
  const logic = typeof parsed.logic_explanation === "string" ? parsed.logic_explanation : "";
  const plain = typeof parsed.logic_explanation_plaintext === "string" ? parsed.logic_explanation_plaintext : "";
  const nextLogic = replaceThisVariantSignificance(logic, variationId, significance);
  const nextPlain = replaceThisVariantSignificance(plain, variationId, significance);
  const current = String(parsed.clinvar_sig ?? "").trim();
  if (
    current === significance
    && document.highlights.clinvarSignificance === significance
    && nextLogic === logic
    && nextPlain === plain
  ) return document;
  return {
    ...document,
    highlights: {
      ...document.highlights,
      clinvarSignificance: significance,
    },
    engine: {
      ...document.engine,
      parsedData: {
        ...parsed,
        clinvar_sig: significance,
        ...(nextLogic !== logic ? { logic_explanation: nextLogic } : {}),
        ...(nextPlain !== plain ? { logic_explanation_plaintext: nextPlain } : {}),
      },
    },
  };
}

/**
 * Minus-strand genes store the coding bases (KIF21B c.4625A>G) while ClinVar is
 * the forward genomic allele at the same position (T>C).
 */
export function complementAllele(ref: string, alt: string): { ref: string; alt: string } | null {
  const flippedRef = reverseComplementAllele(ref);
  const flippedAlt = reverseComplementAllele(alt);
  if (!flippedRef || !flippedAlt) return null;
  if (flippedRef === ref.trim().toUpperCase() && flippedAlt === alt.trim().toUpperCase()) return null;
  return { ref: flippedRef, alt: flippedAlt };
}

/** Check the claimed variation against the local ClinVar VCF. Leave the document alone if the file cannot be read. */
export async function alignClinvarClaim<T extends CurationDocument>(document: T): Promise<T> {
  const parsed = document.engine.parsedData;
  const claimed = String(parsed.clinvar_rcv ?? "").trim();
  if (!/^\d+$/.test(claimed)) return document;
  const chrom = String(parsed.grch38_chrom || document.variant.chromosome || "");
  const position = Number(parsed.grch38_start);
  const ref = String(parsed.ref || "");
  const alt = String(parsed.alt || "");
  if (!chrom || !Number.isInteger(position) || !ref || !alt) return document;
  const aligned = await alignStoredIndel(chrom, position, ref, alt);
  let matched: ClinvarRecordLookup = await clinvarRecordAt(chrom, aligned.position, aligned.ref, aligned.alt);
  if (!matched.available) return document;
  const strand = Number(parsed.strand ?? document.variant.strand ?? 0);
  if (!matched.id && strand < 0) {
    const flipped = complementAllele(aligned.ref, aligned.alt);
    if (flipped) {
      const coding = await clinvarRecordAt(chrom, aligned.position, flipped.ref, flipped.alt);
      if (!coding.available) return document;
      if (coding.id) matched = coding;
    }
  }
  if (matched.id === claimed && matched.significance) return withMatchedClinvarSignificance(document, matched.significance);
  return withoutUnmatchedClinvar(document, matched.id);
}

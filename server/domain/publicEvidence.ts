import type { Variant } from "../../drizzle/schema";

export type PublicEvidenceDraft = {
  source: "ClinVar" | "PubMed" | "gnomAD" | "OMIM" | "CIViC" | "OncoKB";
  sourceRecordId: string | null;
  clinicalDomain: "germline_classification" | "oncogenicity" | "therapeutic" | "diagnostic" | "prognostic" | "population" | "functional" | "other";
  title: string;
  url: string;
  excerpt: string;
  direction: "supporting" | "contradicting" | "neutral";
  evidenceLevel: string | null;
  payload: Record<string, unknown>;
};

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Genolyx-Variant-Interpreter/1.0 (clinical evidence retrieval)" },
    });
    if (!response.ok) throw new Error(`Evidence source returned ${response.status}`);
    return (await response.json()) as Record<string, any>;
  } finally {
    clearTimeout(timeout);
  }
}

function evidenceQuery(variant: Variant) {
  return [variant.gene, variant.hgvsC, variant.hgvsP].filter(Boolean).join(" ");
}

async function collectClinVar(variant: Variant): Promise<PublicEvidenceDraft[]> {
  const query = evidenceQuery(variant);
  if (!query) return [];
  const search = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&retmode=json&retmax=5&term=${encodeURIComponent(query)}`
  );
  const ids = (search.esearchresult?.idlist || []) as string[];
  if (!ids.length) return [];
  const summary = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&retmode=json&id=${ids.join(",")}`
  );
  return ids.flatMap(id => {
    const record = summary.result?.[id];
    if (!record) return [];
    const significance = record.clinical_significance?.description || "Not provided";
    return [{
      source: "ClinVar" as const,
      sourceRecordId: record.accession || id,
      clinicalDomain: "germline_classification" as const,
      title: record.title || `ClinVar ${record.accession || id}`,
      url: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${id}/`,
      excerpt: `ClinVar clinical significance: ${significance}. Review status: ${record.clinical_significance?.review_status || "not provided"}.`,
      direction: "neutral" as const,
      evidenceLevel: record.clinical_significance?.review_status || null,
      payload: { uid: id, accession: record.accession, significance },
    }];
  });
}

async function collectPubMed(variant: Variant): Promise<PublicEvidenceDraft[]> {
  const query = evidenceQuery(variant);
  if (!query) return [];
  const search = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&sort=relevance&term=${encodeURIComponent(query)}`
  );
  const ids = (search.esearchresult?.idlist || []) as string[];
  if (!ids.length) return [];
  const summary = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`
  );
  return ids.flatMap(id => {
    const record = summary.result?.[id];
    if (!record) return [];
    return [{
      source: "PubMed" as const,
      sourceRecordId: id,
      clinicalDomain: "other" as const,
      title: record.title || `PubMed ${id}`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      excerpt: `${record.title || "Untitled publication"} (${record.sortpubdate || record.pubdate || "date not provided"}).`,
      direction: "neutral" as const,
      evidenceLevel: "Literature search result",
      payload: { uid: id, authors: record.authors, source: record.source },
    }];
  });
}

export async function collectPublicEvidence(
  variant: Variant,
  options: { purpose?: "germline" | "somatic"; diseaseContext?: string | null } = {}
) {
  const results: PublicEvidenceDraft[] = [];
  const purpose = options.purpose ?? "germline";

  if (purpose === "somatic") {
    const { loadSomaticKnowledge } = await import("./somaticKb");
    const knowledge = await loadSomaticKnowledge(variant, options.diseaseContext ?? null);
    results.push(...knowledge.drafts);
  } else {
    const settled = await Promise.allSettled([collectClinVar(variant), collectPubMed(variant)]);
    for (const result of settled) if (result.status === "fulfilled") results.push(...result.value);
    if (variant.gene) {
      results.push({
        source: "OMIM",
        sourceRecordId: variant.gene,
        clinicalDomain: "other",
        title: `OMIM search for ${variant.gene}`,
        url: `https://omim.org/search?index=entry&search=${encodeURIComponent(variant.gene)}`,
        excerpt: "OMIM licensed content is not automatically ingested. Verify gene–disease relationships via the link and add only permitted evidence to the Evidence Ledger.",
        direction: "neutral",
        evidenceLevel: "External verification required",
        payload: { gene: variant.gene, licensedContentIngested: false },
      });
    }
  }

  if (variant.populationAf !== null) {
    results.push({
      source: "gnomAD",
      sourceRecordId: variant.normalizedId,
      clinicalDomain: "population",
      title: `gnomAD population frequency for ${variant.normalizedId}`,
      url: `https://gnomad.broadinstitute.org/variant/${encodeURIComponent(`${variant.chromosome}-${variant.position}-${variant.referenceAllele}-${variant.alternateAllele}`)}?dataset=gnomad_r4`,
      excerpt: `Population allele frequency recorded in the input VCF annotation is ${variant.populationAf}. Verify the population and dataset version in the original gnomAD record.`,
      direction: "neutral",
      evidenceLevel: "VCF provenance",
      payload: {
        populationAf: Number(variant.populationAf),
        provenance: "input_vcf_annotation",
      },
    });
  }
  return results;
}

import type { Variant } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import {
  civicLevelToAmp,
  oncokbLevelToAmp,
  oncokbOncogenicity,
  type AmpFact,
  type AmpLevel,
} from "./amp";
import { civicVariantMatches, proteinChangeFromHgvs } from "./proteinChange";

export type SomaticEvidenceDraft = {
  source: "CIViC" | "OncoKB";
  sourceRecordId: string | null;
  clinicalDomain: "oncogenicity" | "therapeutic" | "diagnostic" | "prognostic";
  title: string;
  url: string;
  excerpt: string;
  direction: "supporting" | "contradicting" | "neutral";
  evidenceLevel: string | null;
  payload: Record<string, unknown>;
};

export type SomaticKnowledge = {
  drafts: SomaticEvidenceDraft[];
  facts: AmpFact[];
  sourcesDisabled: string[];
};

const CIVIC_GRAPHQL = "https://civicdb.org/api/graphql";
const ONCOKB_ANNOTATE = "https://www.oncokb.org/api/v1/annotate/mutations";

const cache = new Map<string, { at: number; value: SomaticKnowledge }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

const CIVIC_QUERY = `
query GeneVariants($symbol: String!, $variant: String) {
  gene(entrezSymbol: $symbol) {
    id
    name
    variants(name: $variant, first: 20) {
      nodes {
        id
        name
        singleVariantMolecularProfile {
          id
          evidenceItems(first: 50) {
            nodes {
              id
              name
              status
              evidenceType
              evidenceLevel
              evidenceDirection
              significance
              disease { name }
              therapies { name }
            }
          }
        }
      }
    }
  }
}
`;

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Genolyx-Variant-Interpreter/1.0 (somatic evidence retrieval)",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Record<string, any>;
  } finally {
    clearTimeout(timeout);
  }
}

function diseaseOverlap(disease: string | null | undefined, context: string | null | undefined): boolean {
  if (!disease || !context) return false;
  const tokens = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length > 3 && token !== "cancer" && token !== "tumor" && token !== "tumour");
  const left = new Set(tokens(disease));
  return tokens(context).some(token => left.has(token));
}

function civicDomain(evidenceType: string | null | undefined): SomaticEvidenceDraft["clinicalDomain"] {
  const type = (evidenceType || "").toLowerCase();
  if (type.includes("predict")) return "therapeutic";
  if (type.includes("diagnos")) return "diagnostic";
  if (type.includes("prognos")) return "prognostic";
  return "oncogenicity";
}

function civicDirection(direction: string | null | undefined): SomaticEvidenceDraft["direction"] {
  const value = (direction || "").toLowerCase();
  if (value.includes("does not support") || value.includes("refut")) return "contradicting";
  if (value.includes("support")) return "supporting";
  return "neutral";
}

type CivicEvidenceNode = {
  id?: number | string;
  name?: string;
  status?: string;
  evidenceType?: string;
  evidenceLevel?: string;
  evidenceDirection?: string;
  significance?: string;
  disease?: { name?: string } | null;
  therapies?: Array<{ name?: string }> | null;
};

function civicDraftsFromGene(
  gene: string,
  change: string | null,
  diseaseContext: string | null,
  payload: Record<string, any>
): SomaticEvidenceDraft[] {
  const genes = payload?.data?.genes?.nodes
    ?? (payload?.data?.gene ? [payload.data.gene] : []);
  const drafts: SomaticEvidenceDraft[] = [];
  for (const geneNode of genes) {
    const variants = geneNode?.variants?.nodes ?? [];
    for (const variant of variants) {
      const name = String(variant?.name || "");
      if (change && !civicVariantMatches(name, change)) continue;
      if (!change && name && name.toUpperCase() !== "MUTATION") continue;
      const items: CivicEvidenceNode[] =
        variant?.singleVariantMolecularProfile?.evidenceItems?.nodes ?? [];
      for (const item of items) {
        if ((item.status || "").toUpperCase() && (item.status || "").toUpperCase() !== "ACCEPTED") {
          continue;
        }
        const id = item.id != null ? String(item.id) : null;
        const disease = item.disease?.name || null;
        const therapies = (item.therapies || []).map(t => t.name).filter(Boolean).join(", ");
        const domain = civicDomain(item.evidenceType);
        drafts.push({
          source: "CIViC",
          sourceRecordId: id,
          clinicalDomain: domain,
          title: `${gene} ${name}: CIViC ${item.evidenceType || "evidence"} ${item.evidenceLevel || ""}`.trim(),
          url: id ? `https://civicdb.org/evidence/${id}` : `https://civicdb.org/search/variants?query=${encodeURIComponent(`${gene} ${name}`)}`,
          excerpt: [
            item.significance ? `Significance: ${item.significance}.` : null,
            disease ? `Disease: ${disease}.` : null,
            therapies ? `Therapies: ${therapies}.` : null,
            item.evidenceDirection ? `Direction: ${item.evidenceDirection}.` : null,
          ]
            .filter(Boolean)
            .join(" "),
          direction: civicDirection(item.evidenceDirection),
          evidenceLevel: item.evidenceLevel || null,
          payload: {
            civicEvidenceId: id,
            civicVariantName: name,
            evidenceType: item.evidenceType,
            evidenceLevel: item.evidenceLevel,
            evidenceDirection: item.evidenceDirection,
            significance: item.significance,
            disease,
            therapies,
            sameTumor: diseaseOverlap(disease, diseaseContext),
            ampLevel: civicLevelToAmp(item.evidenceLevel),
          },
        });
      }
    }
  }
  return drafts;
}

async function collectCivic(
  variant: Variant,
  diseaseContext: string | null
): Promise<SomaticEvidenceDraft[]> {
  if (!variant.gene) return [];
  const change = proteinChangeFromHgvs(variant.hgvsP);
  if (!change) return [];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ENV.civicApiKey) headers.Authorization = `Bearer ${ENV.civicApiKey}`;
  const payload = await fetchJson(CIVIC_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: CIVIC_QUERY,
      variables: { symbol: variant.gene, variant: change },
    }),
  });
  if (payload.errors) throw new Error(String(payload.errors[0]?.message || "CIViC GraphQL error"));
  return civicDraftsFromGene(variant.gene, change, diseaseContext, payload);
}

type OncoKbAnnotation = {
  query?: { hugoSymbol?: string; alteration?: string; tumorType?: string };
  oncogenic?: string;
  mutationEffect?: { knownEffect?: string };
  highestSensitiveLevel?: string | null;
  highestResistanceLevel?: string | null;
  highestDiagnosticImplicationLevel?: string | null;
  highestPrognosticImplicationLevel?: string | null;
  treatments?: Array<{ level?: string; drugs?: Array<{ drugName?: string }>; levelAssociatedCancerType?: { mainType?: string } }>;
  hotspot?: boolean;
};

function oncokbDrafts(
  variant: Variant,
  change: string | null,
  diseaseContext: string | null,
  annotation: OncoKbAnnotation
): SomaticEvidenceDraft[] {
  const gene = variant.gene || annotation.query?.hugoSymbol || "";
  const alteration = annotation.query?.alteration || change || "";
  const url = `https://www.oncokb.org/gene/${encodeURIComponent(gene)}/${encodeURIComponent(alteration)}`;
  const drafts: SomaticEvidenceDraft[] = [];

  if (annotation.oncogenic) {
    drafts.push({
      source: "OncoKB",
      sourceRecordId: `${gene}:${alteration}:oncogenic`,
      clinicalDomain: "oncogenicity",
      title: `OncoKB oncogenicity for ${gene} ${alteration}`,
      url,
      excerpt: `OncoKB oncogenic classification: ${annotation.oncogenic}. Mutation effect: ${annotation.mutationEffect?.knownEffect || "not stated"}.${annotation.hotspot ? " Marked as a mutational hotspot." : ""}`,
      direction: "neutral",
      evidenceLevel: annotation.oncogenic,
      payload: {
        oncogenic: annotation.oncogenic,
        mutationEffect: annotation.mutationEffect?.knownEffect,
        hotspot: annotation.hotspot === true,
        ampLevel: null,
        sameTumor: Boolean(diseaseContext),
      },
    });
  }

  const levelRows: Array<{ level: string | null | undefined; domain: SomaticEvidenceDraft["clinicalDomain"]; label: string }> = [
    { level: annotation.highestSensitiveLevel, domain: "therapeutic", label: "sensitive" },
    { level: annotation.highestResistanceLevel, domain: "therapeutic", label: "resistance" },
    { level: annotation.highestDiagnosticImplicationLevel, domain: "diagnostic", label: "diagnostic" },
    { level: annotation.highestPrognosticImplicationLevel, domain: "prognostic", label: "prognostic" },
  ];
  for (const row of levelRows) {
    if (!row.level) continue;
    const drugs = (annotation.treatments || [])
      .filter(t => t.level === row.level)
      .flatMap(t => (t.drugs || []).map(d => d.drugName).filter(Boolean));
    drafts.push({
      source: "OncoKB",
      sourceRecordId: `${gene}:${alteration}:${row.label}:${row.level}`,
      clinicalDomain: row.domain,
      title: `OncoKB ${row.label} ${row.level} for ${gene} ${alteration}`,
      url,
      excerpt: [
        `OncoKB ${row.label} level ${row.level}.`,
        drugs.length ? `Therapies: ${drugs.slice(0, 8).join(", ")}.` : null,
        annotation.query?.tumorType ? `Queried tumour type: ${annotation.query.tumorType}.` : null,
      ]
        .filter(Boolean)
        .join(" "),
      direction: row.label === "resistance" ? "contradicting" : "supporting",
      evidenceLevel: row.level,
      payload: {
        oncokbLevel: row.level,
        ampLevel: oncokbLevelToAmp(row.level),
        sameTumor: Boolean(diseaseContext),
        drugs,
      },
    });
  }
  return drafts;
}

async function collectOncokb(
  variant: Variant,
  diseaseContext: string | null
): Promise<SomaticEvidenceDraft[]> {
  if (!ENV.oncokbToken) throw new Error("oncokb_not_configured");
  const change = proteinChangeFromHgvs(variant.hgvsP);
  const genome = variant.referenceBuild === "GRCh37" ? "GRCh37" : "GRCh38";
  const headers = { Authorization: `Bearer ${ENV.oncokbToken}` };
  let annotation: OncoKbAnnotation | null = null;

  if (variant.gene && change) {
    const params = new URLSearchParams({
      hugoSymbol: variant.gene,
      alteration: change,
      referenceGenome: genome,
    });
    if (diseaseContext) params.set("tumorType", diseaseContext.slice(0, 80));
    annotation = (await fetchJson(`${ONCOKB_ANNOTATE}/byProteinChange?${params}`, { headers })) as OncoKbAnnotation;
  } else if (variant.chromosome && variant.position && variant.referenceAllele && variant.alternateAllele) {
    const genomicLocation = [
      variant.chromosome.replace(/^chr/i, ""),
      variant.position,
      variant.position + Math.max(variant.referenceAllele.length - 1, 0),
      variant.referenceAllele,
      variant.alternateAllele,
    ].join(",");
    const params = new URLSearchParams({ genomicLocation, referenceGenome: genome });
    if (diseaseContext) params.set("tumorType", diseaseContext.slice(0, 80));
    annotation = (await fetchJson(`${ONCOKB_ANNOTATE}/byGenomicChange?${params}`, { headers })) as OncoKbAnnotation;
  }
  if (!annotation) return [];
  return oncokbDrafts(variant, change, diseaseContext, annotation);
}

export function factsFromSomaticDrafts(
  drafts: readonly SomaticEvidenceDraft[],
  extra: AmpFact[] = []
): AmpFact[] {
  const fromDrafts: AmpFact[] = drafts.map(draft => ({
    source: draft.source,
    ampLevel: (draft.payload.ampLevel as AmpLevel | null) ?? null,
    clinicalDomain: draft.clinicalDomain,
    sameTumor: draft.payload.sameTumor === true,
    oncogenicLabel:
      draft.source === "OncoKB"
        ? String(draft.payload.oncogenic || draft.evidenceLevel || "")
        : draft.clinicalDomain === "oncogenicity"
          ? String(draft.payload.significance || "")
          : null,
    title: draft.title,
  }));
  return [...fromDrafts, ...extra];
}

export function factsFromLedger(
  rows: Array<{
    source: string;
    clinicalDomain: string;
    evidenceLevel: string | null;
    payload: Record<string, unknown> | null;
    title?: string | null;
  }>
): AmpFact[] {
  const facts: AmpFact[] = [];
  for (const row of rows) {
    if (row.source !== "CIViC" && row.source !== "OncoKB" && row.source !== "gnomAD" && row.source !== "ClinVar") {
      continue;
    }
    const payload = row.payload || {};
    const ampLevel =
      (payload.ampLevel as AmpLevel | null) ??
      (row.source === "OncoKB" ? oncokbLevelToAmp(row.evidenceLevel) : civicLevelToAmp(row.evidenceLevel));
    facts.push({
      source: row.source,
      ampLevel,
      clinicalDomain: (
        ["therapeutic", "diagnostic", "prognostic", "oncogenicity", "population"] as const
      ).includes(row.clinicalDomain as AmpFact["clinicalDomain"])
        ? (row.clinicalDomain as AmpFact["clinicalDomain"])
        : "oncogenicity",
      sameTumor: payload.sameTumor === true,
      oncogenicLabel:
        typeof payload.oncogenic === "string"
          ? payload.oncogenic
          : row.source === "OncoKB" && row.clinicalDomain === "oncogenicity"
            ? row.evidenceLevel
            : null,
      populationAf: typeof payload.populationAf === "number" ? payload.populationAf : null,
      title: row.title || undefined,
    });
  }
  return facts;
}

function cacheKey(variant: Variant, diseaseContext: string | null): string {
  return [
    variant.gene || "",
    variant.hgvsP || "",
    variant.chromosome,
    variant.position,
    variant.referenceAllele,
    variant.alternateAllele,
    variant.referenceBuild,
    diseaseContext || "",
  ].join("|");
}

export function clearSomaticKnowledgeCache() {
  cache.clear();
}

/**
 * Live CIViC + OncoKB lookup for one variant.
 *
 * Cached for 15 minutes so opening the Workbench does not hammer either API.
 * A missing OncoKB token is recorded on `sourcesDisabled` rather than failing
 * the whole refresh — CIViC is public and still produces a tier.
 */
export async function loadSomaticKnowledge(
  variant: Variant,
  diseaseContext: string | null = null
): Promise<SomaticKnowledge> {
  const key = cacheKey(variant, diseaseContext);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const sourcesDisabled: string[] = [];
  const drafts: SomaticEvidenceDraft[] = [];

  const civic = await Promise.allSettled([collectCivic(variant, diseaseContext)]);
  if (civic[0].status === "fulfilled") drafts.push(...civic[0].value);
  else sourcesDisabled.push("civic");

  if (!ENV.oncokbToken) {
    sourcesDisabled.push("oncokb");
  } else {
    const oncokb = await Promise.allSettled([collectOncokb(variant, diseaseContext)]);
    if (oncokb[0].status === "fulfilled") drafts.push(...oncokb[0].value);
    else sourcesDisabled.push("oncokb");
  }

  const value: SomaticKnowledge = {
    drafts,
    facts: factsFromSomaticDrafts(drafts),
    sourcesDisabled,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Exported for unit tests that feed a captured GraphQL payload. */
export const _somaticKbTest = {
  civicDraftsFromGene,
  oncokbDrafts,
  oncokbOncogenicity,
};

import { sql } from "drizzle-orm";
import { classificationFastLabels } from "../../shared/curation/classificationSearch";
import { requireDb } from "./tenant";

export type ClassificationSource = "portal" | "gvc";

export type ClassifiedVariant = {
  runId: number;
  variantId: number;
  caseId: number | null;
  organizationName: string;
  caseNumber: string | null;
  externalOrderId: string | null;
  source: ClassificationSource;
  gene: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  classification: string;
  criteria: string[];
  institutionalLabel: string | null;
  completedAt: string | null;
};

type SummaryShape = {
  classification?: { label?: string | null } | null;
  criteriaCodes?: unknown;
};

type ClassifiedVariantRow = {
  runId: number;
  variantId: number;
  caseId: number | null;
  organizationName: string;
  caseNumber: string | null;
  externalOrderId: string | null;
  fromPortal: boolean;
  gene: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  chromosome: string;
  position: number;
  referenceAllele: string;
  alternateAllele: string;
  institutionalLabel: string | null;
  summary: SummaryShape | null;
  completedAt: Date | string | null;
};

export function likePattern(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, character => `\\${character}`)}%`;
}

export function mapClassifiedVariant(row: ClassifiedVariantRow): ClassifiedVariant {
  const criteria = Array.isArray(row.summary?.criteriaCodes)
    ? row.summary.criteriaCodes.filter((code): code is string => typeof code === "string")
    : [];
  const completed =
    row.completedAt instanceof Date
      ? row.completedAt.toISOString()
      : row.completedAt;
  return {
    runId: Number(row.runId),
    variantId: Number(row.variantId),
    caseId: row.caseId == null ? null : Number(row.caseId),
    organizationName: row.organizationName,
    caseNumber: row.caseNumber,
    externalOrderId: row.externalOrderId,
    source: row.fromPortal ? "portal" : "gvc",
    gene: row.gene,
    hgvsC: row.hgvsC,
    hgvsP: row.hgvsP,
    chrom: row.chromosome,
    pos: Number(row.position),
    ref: row.referenceAllele,
    alt: row.alternateAllele,
    classification: row.summary?.classification?.label || "",
    criteria,
    institutionalLabel: row.institutionalLabel,
    completedAt: completed,
  };
}

function searchClause(
  pattern: string | null,
  source: "all" | "portal" | "gvc",
  call: string | null
) {
  const filters = [
    sql`cr.status = 'succeeded'`,
    sql`cr."variantId" is not null`,
    sql`cr.summary->'classification'->>'label' is not null`,
    sql`cr.id = (
      select cr2.id
      from curation_runs cr2
      where cr2."variantId" = cr."variantId"
        and cr2."organizationId" = cr."organizationId"
        and cr2.status = 'succeeded'
        and cr2.summary->'classification'->>'label' is not null
      order by cr2."completedAt" desc nulls last, cr2.id desc
      limit 1
    )`,
  ];
  if (pattern) {
    filters.push(sql`(
      coalesce(v.gene, '') ilike ${pattern} escape '\\'
      or coalesce(v."hgvsC", '') ilike ${pattern} escape '\\'
      or coalesce(v."hgvsP", '') ilike ${pattern} escape '\\'
      or v.chromosome ilike ${pattern} escape '\\'
      or v."normalizedId" ilike ${pattern} escape '\\'
      or coalesce(c."caseNumber", '') ilike ${pattern} escape '\\'
      or coalesce(c."patientAlias", '') ilike ${pattern} escape '\\'
      or coalesce(cr."institutionalLabel", '') ilike ${pattern} escape '\\'
      or coalesce(cr.summary->'classification'->>'label', '') ilike ${pattern} escape '\\'
      or coalesce(partner."externalOrderId", '') ilike ${pattern} escape '\\'
      or o.name ilike ${pattern} escape '\\'
    )`);
  }
  if (source === "portal") filters.push(sql`partner."caseId" is not null`);
  if (source === "gvc") filters.push(sql`partner."caseId" is null`);
  const labels = call ? classificationFastLabels(call) : null;
  if (labels?.length) {
    filters.push(sql`lower(btrim(coalesce(cr.summary->'classification'->>'label', ''))) in (${sql.join(
      labels.map(label => sql`${label}`),
      sql`, `
    )})`);
  }
  return sql.join(filters, sql` and `);
}

const fromClause = sql`
  from curation_runs cr
  join variants v
    on v.id = cr."variantId" and v."organizationId" = cr."organizationId"
  left join cases c
    on c.id = cr."caseId" and c."organizationId" = cr."organizationId"
  join organizations o on o.id = cr."organizationId"
  left join lateral (
    select
      aj."caseId",
      aj.manifest->'partner'->>'externalOrderId' as "externalOrderId"
    from analysis_jobs aj
    where aj."caseId" = cr."caseId"
      and aj."organizationId" = cr."organizationId"
      and aj.manifest->>'serviceCode' = 'gvi_partner_interpretation'
    limit 1
  ) partner on true
`;

export async function searchClassifiedVariants(input: {
  query: string;
  source: "all" | "portal" | "gvc";
  call?: string | null;
  offset: number;
  limit: number;
}): Promise<{ total: number; items: ClassifiedVariant[] }> {
  const db = await requireDb();
  const pattern = likePattern(input.query);
  const call = input.call ?? null;
  const count = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    ${fromClause}
    where ${searchClause(pattern, input.source, call)}
  `);
  const result = await db.execute<ClassifiedVariantRow>(sql`
    select
      cr.id as "runId",
      cr."variantId" as "variantId",
      cr."caseId" as "caseId",
      o.name as "organizationName",
      c."caseNumber" as "caseNumber",
      partner."externalOrderId" as "externalOrderId",
      (partner."caseId" is not null) as "fromPortal",
      v.gene,
      v."hgvsC" as "hgvsC",
      v."hgvsP" as "hgvsP",
      v.chromosome,
      v.position,
      v."referenceAllele" as "referenceAllele",
      v."alternateAllele" as "alternateAllele",
      cr."institutionalLabel" as "institutionalLabel",
      cr.summary as summary,
      cr."completedAt" as "completedAt"
    ${fromClause}
    where ${searchClause(pattern, input.source, call)}
    order by cr."completedAt" desc nulls last, cr.id desc
    limit ${input.limit}
    offset ${input.offset}
  `);
  return {
    total: Number(count.rows[0]?.total ?? 0),
    items: result.rows.map(mapClassifiedVariant),
  };
}

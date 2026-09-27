import { and, eq } from "drizzle-orm";
import {
  somaticGuidelineRecords,
  somaticKnowledgeProviders,
  somaticKnowledgeReleases,
} from "../../../drizzle/schema";
import { requireDb } from "../tenant";
import {
  parseApprovedGuidelineRule,
  type ApprovedGuidelineRule,
} from "./rules";

export type ActiveGuidelineRuleSet = {
  rules: ApprovedGuidelineRule[];
  ignoredRecordIds: number[];
  releaseVersions: Record<string, string>;
};

/**
 * Load only records that passed release activation and provider license gates.
 * Invalid JSON is ignored fail-closed and exposed in run provenance.
 */
export async function loadActiveGuidelineRules(
  organizationId: number,
  at = new Date()
): Promise<ActiveGuidelineRuleSet> {
  const db = await requireDb();
  const rows = await db
    .select({
      record: somaticGuidelineRecords,
      release: somaticKnowledgeReleases,
      provider: somaticKnowledgeProviders,
    })
    .from(somaticGuidelineRecords)
    .innerJoin(
      somaticKnowledgeReleases,
      and(
        eq(
          somaticKnowledgeReleases.id,
          somaticGuidelineRecords.releaseId
        ),
        eq(
          somaticKnowledgeReleases.organizationId,
          somaticGuidelineRecords.organizationId
        )
      )
    )
    .innerJoin(
      somaticKnowledgeProviders,
      and(
        eq(
          somaticKnowledgeProviders.id,
          somaticKnowledgeReleases.providerId
        ),
        eq(
          somaticKnowledgeProviders.organizationId,
          somaticKnowledgeReleases.organizationId
        )
      )
    )
    .where(
      and(
        eq(somaticGuidelineRecords.organizationId, organizationId),
        eq(somaticKnowledgeReleases.status, "active"),
        eq(somaticKnowledgeReleases.validationStatus, "passed"),
        eq(somaticKnowledgeProviders.enabled, true),
        eq(somaticKnowledgeProviders.licenseStatus, "approved")
      )
    );

  const rules: ApprovedGuidelineRule[] = [];
  const ignoredRecordIds: number[] = [];
  const releaseVersions: Record<string, string> = {};
  for (const { record, release, provider } of rows) {
    const effective =
      (!record.effectiveFrom || record.effectiveFrom <= at) &&
      (!record.effectiveTo || record.effectiveTo >= at);
    if (!effective) continue;

    releaseVersions[provider.code] = release.version;
    const rule = parseApprovedGuidelineRule(record.guideline, {
      recordId: record.id,
      recordKey: record.recordKey,
      releaseId: release.id,
      releaseVersion: release.version,
      providerCode: provider.code,
      sourceCitation: record.sourceCitation,
    });
    if (rule) rules.push(rule);
    else ignoredRecordIds.push(record.id);
  }

  return { rules, ignoredRecordIds, releaseVersions };
}


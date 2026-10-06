import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import {
  cases,
  somaticCaseContexts,
  somaticClinicalAssertions,
  somaticEvidenceRecords,
  somaticInterpretationRunEvents,
  somaticInterpretationRuns,
  somaticPanels,
  somaticPanelVersions,
  somaticTumorTypes,
  somaticVariantAnalyses,
  variants,
} from "../../../drizzle/schema";
import { requireDb } from "../tenant";
import { evidenceDiseaseConcept, matchPinnedDisease } from "./diseaseMatch";
import { loadActiveGuidelineRules } from "./guidelineRules";
import { analyzeSomaticVariantWithReference } from "./normalize";
import type { SomaticEvidenceProvider } from "./provider";
import { classifyNccn } from "./nccn/classify";
import { evaluateSomaticProposal, SOMATIC_RULESET_VERSION } from "./rules";

export const SOMATIC_PIPELINE_VERSION = "somatic-cds-1";
export const SOMATIC_RUN_RULESET_VERSION = SOMATIC_RULESET_VERSION;

export async function loadSomaticCase(organizationId: number, caseId: number) {
  const db = await requireDb();
  const rows = await db
    .select({
      clinicalCase: cases,
      context: somaticCaseContexts,
      tumor: somaticTumorTypes,
      panel: somaticPanels,
      panelVersion: somaticPanelVersions,
    })
    .from(cases)
    .innerJoin(
      somaticCaseContexts,
      and(
        eq(somaticCaseContexts.caseId, cases.id),
        eq(somaticCaseContexts.organizationId, cases.organizationId)
      )
    )
    .innerJoin(
      somaticTumorTypes,
      eq(somaticTumorTypes.id, somaticCaseContexts.primaryTumorTypeId)
    )
    .innerJoin(
      somaticPanelVersions,
      and(
        eq(somaticPanelVersions.id, somaticCaseContexts.panelVersionId),
        eq(somaticPanelVersions.organizationId, cases.organizationId)
      )
    )
    .innerJoin(
      somaticPanels,
      and(
        eq(somaticPanels.id, somaticPanelVersions.panelId),
        eq(somaticPanels.organizationId, cases.organizationId)
      )
    )
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);

  if (!rows[0] || rows[0].clinicalCase.purpose !== "somatic") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This operation is available only for a somatic case with tumor and panel context.",
    });
  }
  return rows[0];
}

export async function addSomaticRunEvent(
  organizationId: number,
  runId: number,
  status:
    | "queued"
    | "validating"
    | "normalizing"
    | "annotating"
    | "ready_for_review"
    | "partial"
    | "failed",
  message: string,
  progressPercent: number,
  metadata?: Record<string, unknown>
) {
  const db = await requireDb();
  await db.insert(somaticInterpretationRunEvents).values({
    organizationId,
    runId,
    status,
    message,
    progressPercent,
    metadata,
  });
}

export async function processSomaticRun(input: {
  organizationId: number;
  runId: number;
  caseId: number;
  evidenceProvider: SomaticEvidenceProvider;
}): Promise<{ success: true } | { success: false; message: string }> {
  const { organizationId, runId, caseId, evidenceProvider } = input;
  const db = await requireDb();
  try {
    const record = await loadSomaticCase(organizationId, caseId);
    const guidelineRuleSet = await loadActiveGuidelineRules(organizationId);
    const caseTumor = {
      ontologySystem: record.tumor.ontologySystem,
      ontologyVersion: record.tumor.ontologyVersion,
      code: record.tumor.code,
    };
    await db
      .update(somaticInterpretationRuns)
      .set({ status: "normalizing", startedAt: new Date() })
      .where(
        and(
          eq(somaticInterpretationRuns.id, runId),
          eq(somaticInterpretationRuns.organizationId, organizationId)
        )
      );
    await addSomaticRunEvent(
      organizationId,
      runId,
      "normalizing",
      "Validating somatic SNV/indel records.",
      15
    );

    const variantRows = await db
      .select()
      .from(variants)
      .where(
        and(
          eq(variants.organizationId, organizationId),
          eq(variants.caseId, caseId)
        )
      )
      .orderBy(asc(variants.id));
    if (!variantRows.length) {
      throw new Error(
        "No VCF variants are available for somatic interpretation."
      );
    }

    const analyses = await Promise.all(
      variantRows.map(async variant => {
        const analysis = await analyzeSomaticVariantWithReference(
          variant,
          record.panelVersion.genomeBuild
        );
        const normalized = analysis.normalizedRepresentation as
          | {
              normalizedId?: unknown;
              chromosome?: unknown;
              position?: unknown;
              reference?: unknown;
              alternate?: unknown;
            }
          | null;
        const evidenceVariant =
          analysis.normalizationStatus === "normalized" &&
          typeof normalized?.normalizedId === "string" &&
          typeof normalized.chromosome === "string" &&
          typeof normalized.position === "number" &&
          typeof normalized.reference === "string" &&
          typeof normalized.alternate === "string"
            ? {
                ...variant,
                normalizedId: normalized.normalizedId,
                chromosome: normalized.chromosome,
                position: normalized.position,
                referenceAllele: normalized.reference,
                alternateAllele: normalized.alternate,
              }
            : variant;
        return { variant, evidenceVariant, analysis };
      })
    );
    for (let offset = 0; offset < analyses.length; offset += 500) {
      await db.insert(somaticVariantAnalyses).values(
        analyses.slice(offset, offset + 500).map(({ variant, analysis }) => ({
          organizationId,
          runId,
          variantId: variant.id,
          ...analysis,
        }))
      );
    }

    const candidates = analyses.filter(item => item.analysis.candidate);
    await db
      .update(somaticInterpretationRuns)
      .set({ status: "annotating" })
      .where(
        and(
          eq(somaticInterpretationRuns.id, runId),
          eq(somaticInterpretationRuns.organizationId, organizationId)
        )
      );
    await addSomaticRunEvent(
      organizationId,
      runId,
      "annotating",
      `Collecting licensed evidence for ${Math.min(candidates.length, 25)} candidate variant(s).`,
      45,
      { candidateCount: candidates.length, providerLimit: 25 }
    );

    const unavailable = new Set<string>();
    const providerCandidates = candidates.slice(0, 25);
    const tumorContext = {
      label: record.tumor.label,
      ontologySystem: record.tumor.ontologySystem,
      ontologyVersion: record.tumor.ontologyVersion,
      code: record.tumor.code,
    };
    const batchEvidence = evidenceProvider.collectBatch
      ? await evidenceProvider.collectBatch(
          providerCandidates.map(item => item.evidenceVariant),
          tumorContext
        )
      : null;
    for (const { variant, evidenceVariant } of providerCandidates) {
      const result =
        batchEvidence?.get(evidenceVariant.normalizedId) ??
        (await evidenceProvider.collect(evidenceVariant, tumorContext));
      result.unavailable.forEach(source => unavailable.add(source));
      const normalizedEvidence = result.records.map(evidence => {
        const evidenceTumor = evidenceDiseaseConcept(evidence.payload);
        const computedDiseaseMatch = evidenceTumor
          ? matchPinnedDisease(caseTumor, evidenceTumor)
          : evidence.diseaseMatch;
        return {
          ...evidence,
          diseaseMatch:
            evidence.diseaseMatch === "manual"
              ? "manual"
              : computedDiseaseMatch,
          payload: {
            ...evidence.payload,
            ...(evidenceTumor
              ? {
                  diseaseMatchProvenance: {
                    method: "version_pinned_ontology",
                    caseTumor,
                    evidenceTumor,
                  },
                }
              : {}),
          },
        };
      });
      const evidenceRows = normalizedEvidence.length
        ? await db
            .insert(somaticEvidenceRecords)
            .values(
              normalizedEvidence.map(evidence => ({
                organizationId,
                runId,
                variantId: variant.id,
                tumorTypeId: record.tumor.id,
                regimenId: null,
                ...evidence,
              }))
            )
            .returning()
        : [];

      const domains = new Map<string, { ids: number[]; summaries: string[] }>();
      for (const evidence of evidenceRows) {
        const existing = domains.get(evidence.clinicalDomain) ?? {
          ids: [],
          summaries: [],
        };
        existing.ids.push(evidence.id);
        existing.summaries.push(evidence.summary);
        domains.set(evidence.clinicalDomain, existing);
      }
      if (!domains.size) {
        domains.set("oncogenicity", { ids: [], summaries: [] });
      }
      for (const [clinicalDomain, evidence] of Array.from(domains.entries())) {
        const domainEvidence = evidenceRows.filter(
          row =>
            row.clinicalDomain === clinicalDomain &&
            row.payload?.researchOnly !== true
        );
        const proposal = evaluateSomaticProposal(domainEvidence, {
          variant: {
            gene: variant.gene,
            normalizedId: variant.normalizedId,
          },
          tumor: caseTumor,
          guidelineRules: guidelineRuleSet.rules,
        });
        const nccn = classifyNccn({
          knowledgeReleaseId: guidelineRuleSet.nccnReleaseId,
          analysisAsOf: new Date().toISOString().slice(0, 10),
          gene: variant.gene,
          variantType: "SNV_INDEL",
          normalizedVariant: variant.hgvsP || variant.hgvsC,
          copyChange: null,
          functionalClass: null,
          variantOrigin: "somatic",
          tumorCode: caseTumor.code,
          patient: {},
          revisions: guidelineRuleSet.nccnRevisions,
        });
        await db.insert(somaticClinicalAssertions).values({
          organizationId,
          runId,
          variantId: variant.id,
          tumorTypeId: record.tumor.id,
          clinicalDomain: clinicalDomain as
            | "oncogenicity"
            | "therapeutic"
            | "diagnostic"
            | "prognostic",
          systemTier: proposal.systemTier,
          systemLevel: proposal.systemLevel,
          finalTier: null,
          finalLevel: null,
          oncogenicity: "Not Evaluated",
          rulesetVersion: SOMATIC_RUN_RULESET_VERSION,
          rationale: proposal.rationale,
          evidenceIds: evidence.ids,
          proposalFlags: {
            conflict: proposal.conflict,
            reasonCodes: proposal.reasonCodes,
            diseaseMatches: Array.from(
              new Set(domainEvidence.map(item => item.diseaseMatch))
            ),
            appliedRule: proposal.appliedRule,
            nccn,
          },
        });
      }
    }

    const partial =
      unavailable.size > 0 || candidates.length > providerCandidates.length;
    const finalStatus = partial ? "partial" : "ready_for_review";
    await db
      .update(somaticInterpretationRuns)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        knowledgeVersions: {
          ...evidenceProvider.knowledgeVersions,
          ...Object.fromEntries(
            Object.entries(guidelineRuleSet.releaseVersions).map(
              ([provider, version]) => [`guideline:${provider}`, version]
            )
          ),
        },
      })
      .where(
        and(
          eq(somaticInterpretationRuns.id, runId),
          eq(somaticInterpretationRuns.organizationId, organizationId)
        )
      );
    await addSomaticRunEvent(
      organizationId,
      runId,
      finalStatus,
      partial
        ? "Somatic review package is ready with provider limitations recorded."
        : "Somatic review package is ready for expert review.",
      100,
      {
        variantCount: variantRows.length,
        candidateCount: candidates.length,
        unavailable: Array.from(unavailable),
        guidelineRuleCount: guidelineRuleSet.rules.length,
        ignoredGuidelineRecordIds: guidelineRuleSet.ignoredRecordIds,
      }
    );
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Somatic interpretation failed.";
    await db
      .update(somaticInterpretationRuns)
      .set({ status: "failed", error: { message }, completedAt: new Date() })
      .where(
        and(
          eq(somaticInterpretationRuns.id, runId),
          eq(somaticInterpretationRuns.organizationId, organizationId)
        )
      );
    await addSomaticRunEvent(organizationId, runId, "failed", message, 0);
    return { success: false, message };
  }
}

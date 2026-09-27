import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  cases,
  reports,
  somaticAssayFindings,
  somaticCaseCoverageSummaries,
  somaticCaseContexts,
  somaticClinicalAssertions,
  somaticEvidenceRecords,
  somaticInterpretationRuns,
  somaticPanels,
  somaticPanelVersions,
  somaticOrganizationPolicyProfiles,
  somaticReinterpretationTasks,
  somaticReportTemplates,
  somaticReportTemplateVersions,
  somaticTumorTypes,
  somaticVariantAnalyses,
  type SomaticReportTemplateSchema,
  users,
  variants,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import {
  canTransitionReport,
  createReportDigest,
  isReportMutable,
} from "../domain/reportSnapshot";
import { validateNegativeReportingPolicy } from "../domain/somatic/policyValidation";
import { evaluateFullPanelNegative } from "../domain/somatic/negativeReporting";
import { evaluateSomaticReportSignPreconditions } from "../domain/somatic/reportSigning";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const plainText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      value => !/[<>]/.test(value),
      "HTML markup is not allowed in report templates."
    );

async function requireNoOpenReinterpretationTasks(
  organizationId: number,
  caseId: number
) {
  const db = await requireDb();
  const tasks = await db
    .select({ id: somaticReinterpretationTasks.id })
    .from(somaticReinterpretationTasks)
    .where(
      and(
        eq(somaticReinterpretationTasks.organizationId, organizationId),
        eq(somaticReinterpretationTasks.caseId, caseId),
        inArray(somaticReinterpretationTasks.status, ["open", "in_review"])
      )
    )
    .limit(10);
  if (tasks.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Complete or dismiss open reinterpretation tasks before report review/signing: ${tasks.map(task => task.id).join(", ")}.`,
    });
  }
}

const sectionId = z.enum([
  "case_summary",
  "significant_findings",
  "genomic_signatures",
  "vus",
  "variant_details",
  "methodology",
  "limitations",
  "references",
  "signatures",
]);

const templateSchema = z.object({
  schemaVersion: z.literal("1"),
  name: plainText(200),
  locale: z.string().trim().min(2).max(20),
  sections: z
    .array(
      z.object({
        id: sectionId,
        visible: z.boolean(),
        title: plainText(200),
        editableIntro: plainText(4000).optional(),
      })
    )
    .min(1)
    .max(20),
  includeTierIV: z.boolean(),
  header: plainText(1000).optional(),
  footer: plainText(1000).optional(),
  disclaimer: plainText(8000),
  negativeResult: z
    .object({
      title: plainText(255),
      summary: plainText(12000),
      interpretation: plainText(30000),
      limitations: plainText(12000),
    })
    .optional(),
});

const editableContentSchema = z.object({
  summary: z.string().max(12000),
  interpretation: z.string().max(30000),
  methodology: z.string().max(12000),
  limitations: z.string().max(12000),
  recommendations: z.string().max(12000),
});

const DEFAULT_TEMPLATE: SomaticReportTemplateSchema = {
  schemaVersion: "1",
  name: "Somatic Cancer Biomarker Report",
  locale: "en",
  sections: [
    {
      id: "case_summary",
      visible: true,
      title: "Patient, Specimen, Tumor and Assay",
    },
    {
      id: "significant_findings",
      visible: true,
      title: "Clinically Significant Alterations",
    },
    {
      id: "genomic_signatures",
      visible: true,
      title: "Genomic Signatures",
      editableIntro:
        "Not assessed in Phase 1 unless explicitly provided by a validated assay.",
    },
    { id: "vus", visible: true, title: "Variants of Unknown Significance" },
    { id: "variant_details", visible: true, title: "Variant Details" },
    { id: "methodology", visible: true, title: "Methodology and Limitations" },
    { id: "references", visible: true, title: "Evidence and References" },
    {
      id: "signatures",
      visible: true,
      title: "Review and Electronic Signature",
    },
  ],
  includeTierIV: false,
  header: "Genolyx Variant Curation",
  footer: "Somatic cancer clinical decision support",
  disclaimer:
    "This report is clinical decision support reviewed by an authorized professional. It does not independently prescribe treatment. Negative, not-tested, and insufficient-coverage claims are not made until panel reportable regions and coverage are validated.",
  negativeResult: {
    title: "Somatic Cancer Biomarker Report — No Reportable Alteration Detected",
    summary:
      "No reportable somatic alteration was detected within the validated scope of this assay.",
    interpretation:
      "No clinically reportable SNV/indel or reviewed biomarker alteration was identified. This result does not exclude alterations outside the validated reportable regions or below the assay limit of detection.",
    limitations:
      "A negative result is limited to the approved panel version, reportable-region artifact, specimen quality, validated alteration classes, and complete coverage documented in this report.",
  },
};

type SomaticFinding = {
  assertionId: number;
  variantId: number;
  gene: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  transcript: string | null;
  vaf: string | null;
  depth: number | null;
  systemTier: "Tier I" | "Tier II" | "Tier III" | "Tier IV" | null;
  systemLevel: "A" | "B" | "C" | "D" | null;
  tier: "Tier I" | "Tier II" | "Tier III" | "Tier IV";
  level: "A" | "B" | "C" | "D" | null;
  oncogenicity: string;
  clinicalDomain: string;
  clinicalEffect: string | null;
  rationale: string;
  evidenceIds: number[];
  rulesetVersion: string;
  proposalFlags: typeof somaticClinicalAssertions.$inferSelect.proposalFlags;
};

async function ensureDefaultTemplate(organizationId: number, userId: number) {
  const db = await requireDb();
  const active = await db
    .select({
      template: somaticReportTemplates,
      version: somaticReportTemplateVersions,
    })
    .from(somaticReportTemplates)
    .innerJoin(
      somaticReportTemplateVersions,
      and(
        eq(
          somaticReportTemplateVersions.id,
          somaticReportTemplates.activeVersionId
        ),
        eq(
          somaticReportTemplateVersions.organizationId,
          somaticReportTemplates.organizationId
        )
      )
    )
    .where(eq(somaticReportTemplates.organizationId, organizationId))
    .orderBy(asc(somaticReportTemplates.id))
    .limit(1);
  if (active[0]) return active[0];

  return db.transaction(async tx => {
    const templates = await tx
      .insert(somaticReportTemplates)
      .values({
        organizationId,
        name: DEFAULT_TEMPLATE.name,
        createdBy: userId,
      })
      .returning();
    const versions = await tx
      .insert(somaticReportTemplateVersions)
      .values({
        organizationId,
        templateId: templates[0].id,
        version: 1,
        status: "published",
        schema: DEFAULT_TEMPLATE,
        createdBy: userId,
        publishedBy: userId,
        publishedAt: new Date(),
      })
      .returning();
    await tx
      .update(somaticReportTemplates)
      .set({ activeVersionId: versions[0].id })
      .where(eq(somaticReportTemplates.id, templates[0].id));
    return { template: templates[0], version: versions[0] };
  });
}

async function loadSomaticReportContext(
  organizationId: number,
  caseId: number
) {
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
      message: "Somatic Clinical Reports are available only for somatic cases.",
    });
  }
  return rows[0];
}

async function approvedFindings(organizationId: number, caseId: number) {
  const db = await requireDb();
  const runRows = await db
    .select()
    .from(somaticInterpretationRuns)
    .where(
      and(
        eq(somaticInterpretationRuns.organizationId, organizationId),
        eq(somaticInterpretationRuns.caseId, caseId)
      )
    )
    .orderBy(desc(somaticInterpretationRuns.createdAt))
    .limit(1);
  const run = runRows[0];
  if (!run)
    return {
      run: null,
      findings: [] as SomaticFinding[],
      unresolved: 0,
      researchOnlyEvidenceIds: [] as number[],
    };
  const rows = await db
    .select({
      assertion: somaticClinicalAssertions,
      variant: variants,
    })
    .from(somaticClinicalAssertions)
    .innerJoin(
      variants,
      and(
        eq(variants.id, somaticClinicalAssertions.variantId),
        eq(variants.organizationId, somaticClinicalAssertions.organizationId)
      )
    )
    .where(
      and(
        eq(somaticClinicalAssertions.organizationId, organizationId),
        eq(somaticClinicalAssertions.runId, run.id)
      )
    );
  const unresolved = rows.filter(
    row =>
      row.assertion.status !== "approved" && row.assertion.status !== "rejected"
  ).length;
  const findings = rows
    .filter(
      row =>
        row.assertion.status === "approved" &&
        row.assertion.finalTier &&
        row.assertion.oncogenicity
    )
    .map(
      ({ assertion, variant }): SomaticFinding => ({
        assertionId: assertion.id,
        variantId: variant.id,
        gene: variant.gene,
        hgvsC: variant.hgvsC,
        hgvsP: variant.hgvsP,
        transcript: variant.transcript,
        vaf: variant.vaf,
        depth: variant.readDepth,
        systemTier: assertion.systemTier,
        systemLevel: assertion.systemLevel,
        tier: assertion.finalTier!,
        level: assertion.finalLevel,
        oncogenicity: assertion.oncogenicity!,
        clinicalDomain: assertion.clinicalDomain,
        clinicalEffect: assertion.clinicalEffect,
        rationale: assertion.rationale,
        evidenceIds: assertion.evidenceIds,
        rulesetVersion: assertion.rulesetVersion,
        proposalFlags: assertion.proposalFlags,
      })
    )
    .sort((a, b) => {
      const order = { "Tier I": 1, "Tier II": 2, "Tier III": 3, "Tier IV": 4 };
      return (
        order[a.tier] - order[b.tier] ||
        (a.gene || "").localeCompare(b.gene || "")
      );
    });
  const evidenceIds = Array.from(
    new Set(findings.flatMap(finding => finding.evidenceIds))
  );
  const evidenceRows = evidenceIds.length
    ? await db
        .select({
          id: somaticEvidenceRecords.id,
          sourceName: somaticEvidenceRecords.sourceName,
          payload: somaticEvidenceRecords.payload,
        })
        .from(somaticEvidenceRecords)
        .where(
          and(
            eq(somaticEvidenceRecords.organizationId, organizationId),
            inArray(somaticEvidenceRecords.id, evidenceIds)
          )
        )
    : [];
  const researchOnlyEvidenceIds = evidenceRows
    .filter(
      evidence =>
        evidence.sourceName.toLowerCase() === "oncokb" &&
        evidence.payload?.researchOnly === true
    )
    .map(evidence => evidence.id);
  return { run, findings, unresolved, researchOnlyEvidenceIds };
}

async function approvedAssayFindings(organizationId: number, caseId: number) {
  const db = await requireDb();
  const [findings, coverageSummaries, policyRows] = await Promise.all([
    db
      .select()
      .from(somaticAssayFindings)
      .where(
        and(
          eq(somaticAssayFindings.organizationId, organizationId),
          eq(somaticAssayFindings.caseId, caseId)
        )
      )
      .orderBy(
        asc(somaticAssayFindings.findingType),
        asc(somaticAssayFindings.id)
      ),
    db
      .select()
      .from(somaticCaseCoverageSummaries)
      .where(
        and(
          eq(somaticCaseCoverageSummaries.organizationId, organizationId),
          eq(somaticCaseCoverageSummaries.caseId, caseId)
        )
      )
      .orderBy(desc(somaticCaseCoverageSummaries.createdAt)),
    db
      .select()
      .from(somaticOrganizationPolicyProfiles)
      .where(
        and(
          eq(somaticOrganizationPolicyProfiles.organizationId, organizationId),
          eq(somaticOrganizationPolicyProfiles.status, "active")
        )
      )
      .limit(1),
  ]);
  const policy = policyRows[0];
  const policyValidation = policy
    ? validateNegativeReportingPolicy(
        policy.allowNegativeReporting,
        policy.policy
      )
    : { valid: true };
  const reportable = findings.filter(finding => finding.reportable);
  const negativeReportable = reportable.filter(
    finding =>
      finding.status === "not_detected" || finding.status === "not_tested"
  );
  return {
    findings: reportable,
    unresolved: findings.filter(finding => finding.reviewedAt == null).length,
    invalidNegative:
      negativeReportable.length > 0 &&
      (!policy?.allowNegativeReporting || !policyValidation.valid)
        ? negativeReportable.length
        : 0,
    coverageSummaries: coverageSummaries.filter(summary =>
      reportable.some(finding => finding.coverageSummaryId === summary.id)
    ),
    latestCoverageSummary: coverageSummaries[0] ?? null,
    policyAllowsNegative: Boolean(policy?.allowNegativeReporting),
    policyValidationPassed: Boolean(policy && policyValidation.valid),
    hasDisqualifyingAssayFinding: reportable.some(
      finding => finding.status !== "not_detected"
    ),
    policy: policy
      ? {
          id: policy.id,
          name: policy.name,
          version: policy.version,
          contentHash: policy.contentHash,
          allowNegativeReporting: policy.allowNegativeReporting,
        }
      : null,
  };
}

function fullPanelNegativeEligibility(
  context: Awaited<ReturnType<typeof loadSomaticReportContext>>,
  assertions: Awaited<ReturnType<typeof approvedFindings>>,
  assay: Awaited<ReturnType<typeof approvedAssayFindings>>
) {
  const coverage = assay.latestCoverageSummary;
  return evaluateFullPanelNegative({
    runStatus: assertions.run?.status ?? null,
    approvedAssertionCount: assertions.findings.length,
    unresolvedAssertionCount: assertions.unresolved,
    unresolvedAssayFindingCount: assay.unresolved,
    hasDisqualifyingAssayFinding: assay.hasDisqualifyingAssayFinding,
    panelRegionValidationStatus: context.panelVersion.regionValidationStatus,
    panelRegionArtifactHash: context.panelVersion.regionArtifactHash,
    coverage: coverage
      ? {
          validationStatus: coverage.validationStatus,
          completeRegionCount: coverage.completeRegionCount,
          expectedRegionCount: coverage.expectedRegionCount,
          sourceArtifactHash: coverage.sourceArtifactHash,
          validationHash: coverage.validationHash,
        }
      : null,
    allowNegativeReporting: assay.policyAllowsNegative,
    policyValidationPassed: assay.policyValidationPassed,
  });
}

async function requireSomaticReport(organizationId: number, reportId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.id, reportId),
        eq(reports.organizationId, organizationId),
        isNotNull(reports.somaticTemplateVersionId)
      )
    )
    .limit(1);
  if (!rows[0])
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Somatic report not found.",
    });
  return rows[0];
}

export const somaticReportsRouter = router({
  templates: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:read"
      );
      await ensureDefaultTemplate(input.organizationId, ctx.user.id);
      const db = await requireDb();
      return db
        .select({
          template: somaticReportTemplates,
          activeVersion: somaticReportTemplateVersions,
        })
        .from(somaticReportTemplates)
        .leftJoin(
          somaticReportTemplateVersions,
          and(
            eq(
              somaticReportTemplateVersions.id,
              somaticReportTemplates.activeVersionId
            ),
            eq(
              somaticReportTemplateVersions.organizationId,
              somaticReportTemplates.organizationId
            )
          )
        )
        .where(eq(somaticReportTemplates.organizationId, input.organizationId))
        .orderBy(asc(somaticReportTemplates.name));
    }),

  createTemplateVersion: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        templateId: z.number().int().positive().optional(),
        name: plainText(200),
        schema: templateSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:draft"
      );
      const db = await requireDb();
      const result = await db.transaction(async tx => {
        let templateId = input.templateId;
        if (!templateId) {
          const rows = await tx
            .insert(somaticReportTemplates)
            .values({
              organizationId: input.organizationId,
              name: input.name,
              createdBy: ctx.user.id,
            })
            .returning({ id: somaticReportTemplates.id });
          templateId = rows[0].id;
        }
        const existing = await tx
          .select({ version: somaticReportTemplateVersions.version })
          .from(somaticReportTemplateVersions)
          .where(
            and(
              eq(
                somaticReportTemplateVersions.organizationId,
                input.organizationId
              ),
              eq(somaticReportTemplateVersions.templateId, templateId)
            )
          )
          .orderBy(desc(somaticReportTemplateVersions.version))
          .limit(1);
        const rows = await tx
          .insert(somaticReportTemplateVersions)
          .values({
            organizationId: input.organizationId,
            templateId,
            version: (existing[0]?.version || 0) + 1,
            status: "draft",
            schema: input.schema,
            createdBy: ctx.user.id,
          })
          .returning();
        return rows[0];
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report_template.version_created",
        entityType: "somatic_report_template_version",
        entityId: result.id,
        after: { templateId: result.templateId, version: result.version },
        req: ctx.req,
      });
      return result;
    }),

  publishTemplateVersion: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        versionId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:review"
      );
      const db = await requireDb();
      const published = await db.transaction(async tx => {
        const rows = await tx
          .select()
          .from(somaticReportTemplateVersions)
          .where(
            and(
              eq(somaticReportTemplateVersions.id, input.versionId),
              eq(
                somaticReportTemplateVersions.organizationId,
                input.organizationId
              )
            )
          )
          .limit(1);
        if (!rows[0] || rows[0].status !== "draft") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Only a draft template version can be published.",
          });
        }
        await tx
          .update(somaticReportTemplateVersions)
          .set({ status: "retired" })
          .where(
            and(
              eq(
                somaticReportTemplateVersions.organizationId,
                input.organizationId
              ),
              eq(somaticReportTemplateVersions.templateId, rows[0].templateId),
              eq(somaticReportTemplateVersions.status, "published")
            )
          );
        const result = await tx
          .update(somaticReportTemplateVersions)
          .set({
            status: "published",
            publishedBy: ctx.user.id,
            publishedAt: new Date(),
          })
          .where(eq(somaticReportTemplateVersions.id, input.versionId))
          .returning();
        await tx
          .update(somaticReportTemplates)
          .set({ activeVersionId: input.versionId })
          .where(
            and(
              eq(somaticReportTemplates.id, rows[0].templateId),
              eq(somaticReportTemplates.organizationId, input.organizationId)
            )
          );
        return result[0];
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report_template.published",
        entityType: "somatic_report_template_version",
        entityId: input.versionId,
        after: { templateId: published.templateId, version: published.version },
        req: ctx.req,
      });
      return published;
    }),

  createDraft: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        caseId: z.number().int().positive(),
        templateVersionId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:draft"
      );
      const context = await loadSomaticReportContext(
        input.organizationId,
        input.caseId
      );
      const db = await requireDb();
      const findings = await approvedFindings(
        input.organizationId,
        input.caseId
      );
      const assayPackage = await approvedAssayFindings(
        input.organizationId,
        input.caseId
      );
      const negativeEligibility = fullPanelNegativeEligibility(
        context,
        findings,
        assayPackage
      );
      if (
        !findings.run ||
        !["ready_for_review", "partial"].includes(findings.run.status)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Complete a somatic interpretation run before creating a report.",
        });
      }
      if (!findings.findings.length && !negativeEligibility.allowed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `A report requires an approved somatic assertion or a validated full-panel negative result (${negativeEligibility.reasons.join(", ")}).`,
        });
      }
      const selected = input.templateVersionId
        ? await db
            .select({
              template: somaticReportTemplates,
              version: somaticReportTemplateVersions,
            })
            .from(somaticReportTemplateVersions)
            .innerJoin(
              somaticReportTemplates,
              and(
                eq(
                  somaticReportTemplates.id,
                  somaticReportTemplateVersions.templateId
                ),
                eq(
                  somaticReportTemplates.organizationId,
                  somaticReportTemplateVersions.organizationId
                )
              )
            )
            .where(
              and(
                eq(somaticReportTemplateVersions.id, input.templateVersionId),
                eq(
                  somaticReportTemplateVersions.organizationId,
                  input.organizationId
                ),
                eq(somaticReportTemplateVersions.status, "published")
              )
            )
            .limit(1)
        : [await ensureDefaultTemplate(input.organizationId, ctx.user.id)];
      if (!selected[0]?.version) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Published template not found.",
        });
      }
      const isFullPanelNegative =
        findings.findings.length === 0 && negativeEligibility.allowed;
      const negativeCopy = selected[0].version.schema.negativeResult;
      const existing = await db
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.organizationId, input.organizationId),
            eq(reports.caseId, input.caseId),
            isNotNull(reports.somaticTemplateVersionId)
          )
        )
        .orderBy(desc(reports.version))
        .limit(1);
      if (existing[0] && !["signed", "amended"].includes(existing[0].status)) {
        return { id: existing[0].id };
      }
      const content = {
        schemaVersion: "somatic-report-1",
        editable: {
          summary: isFullPanelNegative
            ? negativeCopy?.summary ||
              "No reportable somatic alteration was detected within the validated scope of this assay."
            : `${findings.findings.length} expert-approved somatic assertion(s) and ${assayPackage.findings.length} approved assay finding(s) are included.`,
          interpretation: isFullPanelNegative
            ? negativeCopy?.interpretation ||
              "No clinically reportable alteration was identified within the validated assay scope."
            : findings.findings.map(item => item.rationale).join("\n\n"),
          methodology: `Target-panel VCF; ${context.panel.manufacturer} ${context.panel.name} ${context.panelVersion.version}; ${context.clinicalCase.referenceBuild}.`,
          limitations: isFullPanelNegative
            ? negativeCopy?.limitations || selected[0].version.schema.disclaimer
            : selected[0].version.schema.disclaimer,
          recommendations:
            "Correlate all findings with pathology, clinical history, prior therapy, and applicable jurisdiction-specific guidance.",
        },
        findings: findings.findings,
        assayFindings: assayPackage.findings,
        coverageSummaries:
          isFullPanelNegative && assayPackage.latestCoverageSummary
            ? [assayPackage.latestCoverageSummary]
            : assayPackage.coverageSummaries,
        panelRegionArtifact: {
          name: context.panelVersion.regionArtifactName,
          hash: context.panelVersion.regionArtifactHash,
          validationStatus: context.panelVersion.regionValidationStatus,
          validatedBy: context.panelVersion.regionValidatedBy,
          validatedAt: context.panelVersion.regionValidatedAt,
        },
        negativeReportingPolicy: assayPackage.policy,
        reportConclusion: isFullPanelNegative
          ? {
              type: "full_panel_negative",
              eligibilityReasons: [],
              panelRegionArtifactHash:
                context.panelVersion.regionArtifactHash,
              coverageSummaryId: assayPackage.latestCoverageSummary?.id ?? null,
              coverageValidationHash:
                assayPackage.latestCoverageSummary?.validationHash ?? null,
              policyId: assayPackage.policy?.id ?? null,
              policyVersion: assayPackage.policy?.version ?? null,
            }
          : { type: "findings_present" },
      };
      const rows = await db
        .insert(reports)
        .values({
          organizationId: input.organizationId,
          caseId: input.caseId,
          version: (existing[0]?.version || 0) + 1,
          status: "draft",
          title: isFullPanelNegative
            ? negativeCopy?.title ||
              `${context.clinicalCase.caseNumber} Somatic Cancer Biomarker Report — No Reportable Alteration Detected`
            : `${context.clinicalCase.caseNumber} Somatic Cancer Biomarker Report`,
          content,
          somaticTemplateVersionId: selected[0].version.id,
          parentReportId: existing[0]?.id || null,
          createdBy: ctx.user.id,
        })
        .returning({ id: reports.id });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.draft_created",
        entityType: "report",
        entityId: rows[0].id,
        after: {
          caseId: input.caseId,
          templateVersionId: selected[0].version.id,
          findingCount: findings.findings.length,
          assayFindingCount: assayPackage.findings.length,
        },
        req: ctx.req,
      });
      return { id: rows[0].id };
    }),

  get: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:read"
      );
      const db = await requireDb();
      const rows = await db
        .select({
          report: reports,
          clinicalCase: cases,
          context: somaticCaseContexts,
          tumor: somaticTumorTypes,
          panel: somaticPanels,
          panelVersion: somaticPanelVersions,
          templateVersion: somaticReportTemplateVersions,
          signerName: users.name,
          signerEmail: users.email,
        })
        .from(reports)
        .innerJoin(
          cases,
          and(
            eq(cases.id, reports.caseId),
            eq(cases.organizationId, reports.organizationId)
          )
        )
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
            eq(somaticPanelVersions.organizationId, reports.organizationId)
          )
        )
        .innerJoin(
          somaticPanels,
          and(
            eq(somaticPanels.id, somaticPanelVersions.panelId),
            eq(somaticPanels.organizationId, reports.organizationId)
          )
        )
        .innerJoin(
          somaticReportTemplateVersions,
          and(
            eq(
              somaticReportTemplateVersions.id,
              reports.somaticTemplateVersionId
            ),
            eq(
              somaticReportTemplateVersions.organizationId,
              reports.organizationId
            )
          )
        )
        .leftJoin(users, eq(users.id, reports.signedBy))
        .where(
          and(
            eq(reports.id, input.reportId),
            eq(reports.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!rows[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Report not found.",
        });
      const content = rows[0].report.content as {
        findings?: Array<{ evidenceIds?: number[] }>;
      };
      const evidenceIds = Array.from(
        new Set(
          (content.findings || []).flatMap(finding => finding.evidenceIds || [])
        )
      );
      const evidence = evidenceIds.length
        ? await db
            .select()
            .from(somaticEvidenceRecords)
            .where(
              and(
                eq(somaticEvidenceRecords.organizationId, input.organizationId),
                inArray(somaticEvidenceRecords.id, evidenceIds)
              )
            )
        : [];
      return { ...rows[0], evidence };
    }),

  update: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
        title: plainText(255),
        editable: editableContentSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:draft"
      );
      const report = await requireSomaticReport(
        input.organizationId,
        input.reportId
      );
      if (!isReportMutable(report.status)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a draft report can be edited.",
        });
      }
      const beforeContent = report.content as Record<string, unknown>;
      const content = { ...beforeContent, editable: input.editable };
      const db = await requireDb();
      await db
        .update(reports)
        .set({ title: input.title, content })
        .where(
          and(
            eq(reports.id, input.reportId),
            eq(reports.organizationId, input.organizationId),
            eq(reports.status, "draft")
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.updated",
        entityType: "report",
        entityId: input.reportId,
        before: { title: report.title, editable: beforeContent.editable },
        after: { title: input.title, editable: input.editable },
        req: ctx.req,
      });
      return { success: true };
    }),

  submitReview: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:review"
      );
      const report = await requireSomaticReport(
        input.organizationId,
        input.reportId
      );
      if (!canTransitionReport(report.status, "in_review")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Invalid report state transition.",
        });
      }
      await requireNoOpenReinterpretationTasks(
        input.organizationId,
        report.caseId
      );
      const [context, assertionPackage, assayPackage] = await Promise.all([
        loadSomaticReportContext(input.organizationId, report.caseId),
        approvedFindings(input.organizationId, report.caseId),
        approvedAssayFindings(input.organizationId, report.caseId),
      ]);
      if (assayPackage.unresolved > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "All imported CNV, fusion, MSI, TMB, and HRD findings must be reviewed before report review.",
        });
      }
      if (assayPackage.invalidNegative > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Negative assay findings no longer satisfy the active organization policy.",
        });
      }
      if (assertionPackage.researchOnlyEvidenceIds.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Research/demo OncoKB evidence cannot enter a clinical report. Configure an approved commercial license and rerun interpretation.",
        });
      }
      const existingContent = report.content as Record<string, unknown> & {
        reportConclusion?: { type?: string };
      };
      const negativeEligibility = fullPanelNegativeEligibility(
        context,
        assertionPackage,
        assayPackage
      );
      const isFullPanelNegative =
        existingContent.reportConclusion?.type === "full_panel_negative";
      if (isFullPanelNegative && !negativeEligibility.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Full-panel negative gates no longer pass (${negativeEligibility.reasons.join(", ")}).`,
        });
      }
      const content = {
        ...existingContent,
        findings: assertionPackage.findings,
        assayFindings: assayPackage.findings,
        coverageSummaries:
          isFullPanelNegative && assayPackage.latestCoverageSummary
            ? [assayPackage.latestCoverageSummary]
            : assayPackage.coverageSummaries,
        panelRegionArtifact: {
          name: context.panelVersion.regionArtifactName,
          hash: context.panelVersion.regionArtifactHash,
          validationStatus: context.panelVersion.regionValidationStatus,
          validatedBy: context.panelVersion.regionValidatedBy,
          validatedAt: context.panelVersion.regionValidatedAt,
        },
        negativeReportingPolicy: assayPackage.policy,
      };
      const db = await requireDb();
      await db
        .update(reports)
        .set({ status: "in_review", content })
        .where(
          and(
            eq(reports.id, input.reportId),
            eq(reports.organizationId, input.organizationId),
            eq(reports.status, "draft")
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.review_requested",
        entityType: "report",
        entityId: input.reportId,
        before: { status: "draft" },
        after: {
          status: "in_review",
          findingCount: assertionPackage.findings.length,
          assayFindingCount: assayPackage.findings.length,
        },
        req: ctx.req,
      });
      return { success: true };
    }),

  returnToDraft: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:review"
      );
      const report = await requireSomaticReport(
        input.organizationId,
        input.reportId
      );
      if (!canTransitionReport(report.status, "draft")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Invalid report state transition.",
        });
      }
      const db = await requireDb();
      const rows = await db
        .update(reports)
        .set({ status: "draft" })
        .where(
          and(
            eq(reports.id, input.reportId),
            eq(reports.organizationId, input.organizationId),
            eq(reports.status, "in_review")
          )
        )
        .returning({ id: reports.id });
      if (!rows.length) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Report state changed.",
        });
      }
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.returned_to_draft",
        entityType: "report",
        entityId: input.reportId,
        before: { status: "in_review" },
        after: { status: "draft" },
        req: ctx.req,
      });
      return { success: true };
    }),

  sign: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
        confirmReportId: z.number().int().positive(),
        attestation: z.literal(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:sign"
      );
      if (input.reportId !== input.confirmReportId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Report confirmation mismatch.",
        });
      }
      const report = await requireSomaticReport(
        input.organizationId,
        input.reportId
      );
      if (!canTransitionReport(report.status, "signed")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only an in-review report can be signed.",
        });
      }
      await requireNoOpenReinterpretationTasks(
        input.organizationId,
        report.caseId
      );
      const context = await loadSomaticReportContext(
        input.organizationId,
        report.caseId
      );
      const packageData = await approvedFindings(
        input.organizationId,
        report.caseId
      );
      const assayPackage = await approvedAssayFindings(
        input.organizationId,
        report.caseId
      );
      const reportContent = report.content as Record<string, unknown> & {
        reportConclusion?: { type?: string };
      };
      const negativeEligibility = fullPanelNegativeEligibility(
        context,
        packageData,
        assayPackage
      );
      const fullPanelNegativeEligible =
        reportContent.reportConclusion?.type === "full_panel_negative" &&
        negativeEligibility.allowed;
      const packagePrecondition = evaluateSomaticReportSignPreconditions({
        runStatus: packageData.run?.status ?? null,
        unresolved: packageData.unresolved,
        unresolvedAssayFindings: assayPackage.unresolved,
        invalidNegativeAssayFindings: assayPackage.invalidNegative,
        researchOnlyEvidenceCount: packageData.researchOnlyEvidenceIds.length,
        fullPanelNegativeEligible,
        findings: packageData.findings,
        templateStatus: "published",
      });
      if (!packagePrecondition.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: packagePrecondition.message,
        });
      }
      const db = await requireDb();
      const templateRows = await db
        .select()
        .from(somaticReportTemplateVersions)
        .where(
          and(
            eq(
              somaticReportTemplateVersions.id,
              report.somaticTemplateVersionId!
            ),
            eq(
              somaticReportTemplateVersions.organizationId,
              input.organizationId
            )
          )
        )
        .limit(1);
      const templatePrecondition = evaluateSomaticReportSignPreconditions({
        runStatus: packageData.run?.status ?? null,
        unresolved: packageData.unresolved,
        unresolvedAssayFindings: assayPackage.unresolved,
        invalidNegativeAssayFindings: assayPackage.invalidNegative,
        researchOnlyEvidenceCount: packageData.researchOnlyEvidenceIds.length,
        fullPanelNegativeEligible,
        findings: packageData.findings,
        templateStatus: templateRows[0]?.status ?? null,
      });
      if (!templatePrecondition.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: templatePrecondition.message,
        });
      }
      const interpretationRun = packageData.run!;
      const evidenceIds = packageData.findings.flatMap(
        item => item.evidenceIds
      );
      const evidence = evidenceIds.length
        ? await db
            .select()
            .from(somaticEvidenceRecords)
            .where(
              and(
                eq(somaticEvidenceRecords.organizationId, input.organizationId),
                inArray(somaticEvidenceRecords.id, evidenceIds)
              )
            )
        : [];
      const variantAnalyses = await db
        .select({
          analysis: somaticVariantAnalyses,
          variant: variants,
        })
        .from(somaticVariantAnalyses)
        .innerJoin(
          variants,
          and(
            eq(variants.id, somaticVariantAnalyses.variantId),
            eq(variants.organizationId, somaticVariantAnalyses.organizationId)
          )
        )
        .where(
          and(
            eq(somaticVariantAnalyses.organizationId, input.organizationId),
            eq(somaticVariantAnalyses.runId, interpretationRun.id)
          )
        )
        .orderBy(asc(variants.chromosome), asc(variants.position));
      const signedAt = new Date();
      const signedContent = {
        ...reportContent,
        findings: packageData.findings,
        assayFindings: assayPackage.findings,
        coverageSummaries:
          fullPanelNegativeEligible && assayPackage.latestCoverageSummary
            ? [assayPackage.latestCoverageSummary]
            : assayPackage.coverageSummaries,
        panelRegionArtifact: {
          name: context.panelVersion.regionArtifactName,
          hash: context.panelVersion.regionArtifactHash,
          validationStatus: context.panelVersion.regionValidationStatus,
          validatedBy: context.panelVersion.regionValidatedBy,
          validatedAt: context.panelVersion.regionValidatedAt,
        },
        negativeReportingPolicy: assayPackage.policy,
      };
      const snapshot = JSON.parse(
        JSON.stringify({
          schemaVersion: "somatic-report-snapshot-3",
          report: {
            id: report.id,
            version: report.version,
            title: report.title,
            content: signedContent,
          },
          template: {
            id: templateRows[0].templateId,
            versionId: templateRows[0].id,
            version: templateRows[0].version,
            schema: templateRows[0].schema,
          },
          case: context.clinicalCase,
          tumorContext: context.context,
          tumor: context.tumor,
          panel: context.panel,
          panelVersion: context.panelVersion,
          interpretationRun,
          provenance: {
            assembly: context.clinicalCase.referenceBuild,
            transcriptPolicy: Array.from(
              new Set(
                variantAnalyses
                  .map(row => row.analysis.transcriptPolicy)
                  .filter(Boolean)
              )
            ),
            pipelineVersion: interpretationRun.pipelineVersion,
            rulesetVersion: interpretationRun.rulesetVersion,
            knowledgeVersions: interpretationRun.knowledgeVersions,
            templateVersionId: templateRows[0].id,
          },
          variantAnalyses,
          assertions: packageData.findings,
          assayFindings: assayPackage.findings,
          coverageSummaries:
            fullPanelNegativeEligible && assayPackage.latestCoverageSummary
              ? [assayPackage.latestCoverageSummary]
              : assayPackage.coverageSummaries,
          negativeReportingPolicy: assayPackage.policy,
          evidence,
          signature: {
            userId: ctx.user.id,
            name: ctx.user.name,
            email: ctx.user.email,
            role: membership.role,
            signedAt: signedAt.toISOString(),
            attestation:
              "I reviewed the somatic assertions, evidence, limitations, and current immutable report version.",
          },
        })
      ) as Record<string, unknown>;
      const digest = createReportDigest(snapshot);
      const updated = await db
        .update(reports)
        .set({
          status: "signed",
          content: signedContent,
          snapshot,
          snapshotHash: digest.sha256,
          signedBy: ctx.user.id,
          signedAt,
        })
        .where(
          and(
            eq(reports.id, report.id),
            eq(reports.organizationId, input.organizationId),
            eq(reports.status, "in_review")
          )
        )
        .returning({ id: reports.id });
      if (!updated.length) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Report state changed before signing.",
        });
      }
      await db
        .update(cases)
        .set({ status: "reported" })
        .where(
          and(
            eq(cases.id, report.caseId),
            eq(cases.organizationId, input.organizationId)
          )
        );
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.signed",
        entityType: "report",
        entityId: report.id,
        before: { status: report.status },
        after: {
          status: "signed",
          snapshotHash: digest.sha256,
          templateVersionId: templateRows[0].id,
        },
        req: ctx.req,
      });
      return { snapshotHash: digest.sha256, signedAt };
    }),

  amend: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        reportId: z.number().int().positive(),
        reason: z.string().trim().min(10).max(2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(
        ctx.user.id,
        input.organizationId,
        "report:draft"
      );
      const report = await requireSomaticReport(
        input.organizationId,
        input.reportId
      );
      if (!canTransitionReport(report.status, "amended")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only a signed report can be amended.",
        });
      }
      const db = await requireDb();
      const id = await db.transaction(async tx => {
        await tx
          .update(reports)
          .set({ status: "amended" })
          .where(
            and(
              eq(reports.id, report.id),
              eq(reports.organizationId, input.organizationId),
              eq(reports.status, "signed")
            )
          );
        const rows = await tx
          .insert(reports)
          .values({
            organizationId: input.organizationId,
            caseId: report.caseId,
            version: report.version + 1,
            status: "draft",
            title: `${report.title} — Amendment`,
            content: {
              ...(report.content as Record<string, unknown>),
              amendmentReason: input.reason,
            },
            somaticTemplateVersionId: report.somaticTemplateVersionId,
            parentReportId: report.id,
            createdBy: ctx.user.id,
          })
          .returning({ id: reports.id });
        return rows[0].id;
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "somatic.report.amendment_created",
        entityType: "report",
        entityId: id,
        before: { parentReportId: report.id, parentHash: report.snapshotHash },
        after: { reason: input.reason, version: report.version + 1 },
        req: ctx.req,
      });
      return { id };
    }),
});

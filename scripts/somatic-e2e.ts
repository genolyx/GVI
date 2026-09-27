/**
 * Deterministic end-to-end validation for the somatic CDS workflow.
 *
 *   pnpm exec tsx scripts/somatic-e2e.ts
 *   pnpm exec tsx scripts/somatic-e2e.ts workflow
 *   pnpm exec tsx scripts/somatic-e2e.ts constraints
 *   pnpm exec tsx scripts/somatic-e2e.ts cleanup
 *
 * The script creates two dedicated organizations, injects the synthetic fixture
 * provider explicitly (never live CIViC), and removes only those organizations'
 * data. Deliberate database violations run behind savepoints and are rolled back.
 */
import assert from "node:assert/strict";
import { config } from "dotenv";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import type { TrpcContext } from "../server/_core/context";
import {
  cases,
  organizationMembers,
  organizations,
  projects,
  reports,
  somaticCaseContexts,
  somaticClinicalAssertions,
  somaticEvidenceRecords,
  somaticGuidelineRecords,
  somaticInterpretationRuns,
  somaticKnowledgeEvidenceRecords,
  somaticKnowledgeProviders,
  somaticKnowledgeReleases,
  somaticPanelReportableRegions,
  somaticPanels,
  somaticPanelVersions,
  somaticTumorTypes,
  somaticVariantAnalyses,
  users,
  variants,
  type User,
} from "../drizzle/schema";
import { createReportDigest } from "../server/domain/reportSnapshot";
import {
  offlineEvidenceInsertValues,
  offlineKnowledgeEvidenceSchema,
} from "../server/domain/somatic/offlineKnowledge";
import {
  SOMATIC_PIPELINE_VERSION,
  SOMATIC_RUN_RULESET_VERSION,
} from "../server/domain/somatic/runProcessor";
import { runSomaticWorkerOnce } from "../server/domain/somatic/runWorker";
import { appRouter } from "../server/routers";

config({ path: ".env.local" });
config();

const PRIMARY_SLUG = "e2e-somatic-validation";
const GUARD_SLUG = "e2e-somatic-constraint-guard";
const USER_OPEN_ID = "e2e-somatic-validation-user";
const PROJECT_CODE = "SOM-E2E";
const CASE_NUMBER = "SOM-E2E-001";
const SHA256 = /^[0-9a-f]{64}$/;

type Db = ReturnType<typeof drizzle>;
type Seed = {
  organizationId: number;
  projectId: number;
  caseId: number;
  contextId: number;
  panelVersionId: number;
  variantIds: number[];
  providerId: number;
  releaseId: number | null;
  regionId: number;
};

const requiredConstraints = [
  "somatic_case_contexts_panel_version_org_fk",
  "somatic_interpretation_runs_context_org_fk",
  "somatic_variant_analyses_variant_org_fk",
  "reports_somatic_template_version_org_fk",
  "somatic_knowledge_releases_provider_org_fk",
  "somatic_case_coverage_panel_org_fk",
  "somatic_case_region_coverage_region_org_fk",
  "somatic_assay_findings_coverage_org_fk",
  "somatic_knowledge_releases_activation_ck",
  "somatic_case_coverage_validation_ck",
  "somatic_assay_findings_negative_reportable_ck",
  "somatic_policy_profiles_activation_ck",
  "somatic_clinical_assertions_proposal_flags_ck",
  "somatic_knowledge_evidence_records_release_org_fk",
  "somatic_knowledge_evidence_records_hash_ck",
  "somatic_panel_versions_region_validation_ck",
  "somatic_case_coverage_source_hash_ck",
  "somatic_interpretation_runs_attempts_ck",
] as const;

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required (the script loads .env.local, then .env)."
    );
  }
  return value;
}

async function cleanupDedicatedData(pool: Pool) {
  const client = await pool.connect();
  try {
    const orgRows = await client.query<{ id: number }>(
      `SELECT id FROM organizations WHERE slug = ANY($1::text[])`,
      [[PRIMARY_SLUG, GUARD_SLUG]]
    );
    for (const { id } of orgRows.rows) {
      await deleteOrganizationGraph(client, id);
    }
    await client.query(
      `DELETE FROM somatic_tumor_types
       WHERE "ontologySystem" = 'GVI-E2E'
         AND code = ANY($1::text[])`,
      [[`E2E-${PRIMARY_SLUG}`, `E2E-${GUARD_SLUG}`]]
    );
    await client.query(`DELETE FROM users WHERE "openId" = $1`, [USER_OPEN_ID]);
  } finally {
    client.release();
  }
}

/**
 * Delete child tables before parents by following catalogued foreign keys.
 * Every DELETE remains scoped to the dedicated organization id.
 */
async function deleteOrganizationGraph(
  client: PoolClient,
  organizationId: number
) {
  const scoped = await client.query<{ table_name: string }>(`
    SELECT DISTINCT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attname = 'organizationId'
      AND NOT a.attisdropped
  `);
  const tableNames = new Set(scoped.rows.map(row => row.table_name));
  const fkRows = await client.query<{ child: string; parent: string }>(`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE fk.contype = 'f' AND n.nspname = 'public'
  `);
  const children = new Map<string, Set<string>>();
  for (const { child, parent } of fkRows.rows) {
    if (child !== parent && tableNames.has(child) && tableNames.has(parent)) {
      const values = children.get(parent) ?? new Set<string>();
      values.add(child);
      children.set(parent, values);
    }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(`Unexpected tenant-table FK cycle at ${table}`);
    }
    visiting.add(table);
    for (const child of children.get(table) ?? []) visit(child);
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  };
  for (const table of tableNames) visit(table);

  await client.query("BEGIN");
  try {
    for (const table of ordered) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      await client.query(`DELETE FROM ${quoted} WHERE "organizationId" = $1`, [
        organizationId,
      ]);
    }
    await client.query(`DELETE FROM organizations WHERE id = $1`, [
      organizationId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function ensureUser(db: Db) {
  const rows = await db
    .insert(users)
    .values({
      openId: USER_OPEN_ID,
      name: "Somatic E2E Reviewer",
      email: "somatic-e2e@invalid.local",
      loginMethod: "validation-script",
    })
    .onConflictDoUpdate({
      target: users.openId,
      set: {
        name: "Somatic E2E Reviewer",
        email: "somatic-e2e@invalid.local",
      },
    })
    .returning();
  return rows[0];
}

async function browserValidationUser(db: Db) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, "admin@localhost"))
    .limit(1);
  return rows[0] ?? ensureUser(db);
}

async function seedOrganization(
  db: Db,
  user: User,
  input: {
    slug: string;
    name: string;
    caseNumber: string;
    fixtureVariants: boolean;
  }
): Promise<Seed> {
  const [organization] = await db
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug,
      dataRegion: "KR",
      createdBy: user.id,
    })
    .returning();
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: user.id,
    role: "administrator",
    status: "active",
  });
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: organization.id,
      name: `${input.name} Project`,
      code: PROJECT_CODE,
      createdBy: user.id,
    })
    .returning();
  const [panel] = await db
    .insert(somaticPanels)
    .values({
      organizationId: organization.id,
      manufacturer: "Synthetic",
      name: "Somatic E2E Panel",
      createdBy: user.id,
    })
    .returning();
  const [panelVersion] = await db
    .insert(somaticPanelVersions)
    .values({
      organizationId: organization.id,
      panelId: panel.id,
      version: "fixture-v1",
      genomeBuild: "GRCh38",
      assayType: "targeted DNA",
      capabilities: {
        snvIndel: true,
        cnv: false,
        fusion: false,
        msi: false,
        tmb: true,
        hrd: false,
      },
    })
    .returning();
  const tumorCode = `E2E-${input.slug}`;
  const [tumor] = await db
    .insert(somaticTumorTypes)
    .values({
      ontologySystem: "GVI-E2E",
      ontologyVersion: "1",
      code: tumorCode,
      label: "Non-small cell lung cancer",
      primarySite: "Lung",
    })
    .returning();
  const [clinicalCase] = await db
    .insert(cases)
    .values({
      organizationId: organization.id,
      projectId: project.id,
      caseNumber: input.caseNumber,
      patientAlias: "Synthetic Somatic Validation",
      purpose: "somatic",
      inputType: "vcf",
      referenceBuild: "GRCh38",
      panelName: panel.name,
      indication: "Synthetic validation only",
      consentClinicalAnalysis: true,
      createdBy: user.id,
    })
    .returning();
  const [context] = await db
    .insert(somaticCaseContexts)
    .values({
      organizationId: organization.id,
      caseId: clinicalCase.id,
      primaryTumorTypeId: tumor.id,
      panelVersionId: panelVersion.id,
      specimenCollectionSite: "Synthetic lung specimen",
      pairedNormal: false,
      mappingProvenance: {
        source: "somatic-e2e",
        ontology: "synthetic",
      },
    })
    .returning();
  const [provider] = await db
    .insert(somaticKnowledgeProviders)
    .values({
      organizationId: organization.id,
      code: "CIVIC",
      name: "Synthetic offline CIViC provider",
      enabled: true,
      licenseStatus: "approved",
      licenseReference: "CC0 synthetic fixtures",
      licenseApprovedBy: user.id,
      licenseApprovedAt: new Date(),
      createdBy: user.id,
    })
    .returning();
  let releaseId: number | null = null;
  if (input.fixtureVariants) {
    const activatedAt = new Date("2026-09-27T00:00:00.000Z");
    const [release] = await db
      .insert(somaticKnowledgeReleases)
      .values({
        organizationId: organization.id,
        providerId: provider.id,
        version: "fixture-guideline-1",
        status: "active",
        validationStatus: "passed",
        validationSummary: { fixture: true, result: "passed" },
        contentHash: "c".repeat(64),
        validatedBy: user.id,
        validatedAt: activatedAt,
        activatedBy: user.id,
        activatedAt,
        changeControlId: "SOM-E2E-GUIDELINE",
        changeSummary:
          "Synthetic approved guideline rule for deterministic Phase 2-A validation.",
        createdBy: user.id,
      })
      .returning();
    releaseId = release.id;
    await db.insert(somaticGuidelineRecords).values({
      organizationId: organization.id,
      releaseId: release.id,
      recordKey: "EGFR-L858R-E2E-NSCLC",
      title: "Synthetic EGFR L858R review-only proposal rule",
      guideline: {
        schemaVersion: 1,
        kind: "somatic_amp_proposal_rule",
        gene: "EGFR",
        normalizedVariantId: "GRCh38:7:55259515:T:G",
        clinicalDomain: "therapeutic",
        tumor: {
          ontologySystem: "GVI-E2E",
          ontologyVersion: "1",
          code: tumorCode,
        },
        requiredDirection: "supporting",
        systemTier: "Tier I",
        systemLevel: "A",
      },
      sourceCitation: "Synthetic validation rule; not clinical truth.",
      createdBy: user.id,
    });
    const offlineRecords = [
      {
        normalizedVariantId: "GRCh38:7:55259515:T:G",
        sourceRecordId: "CIVIC-SYN-EGFR-L858R-1",
        sourceNativeLevel: "A",
        clinicalDomain: "therapeutic",
        direction: "supporting",
        diseaseOntology: {
          ontologySystem: "GVI-E2E",
          ontologyVersion: "1",
          code: tumorCode,
        },
        summary:
          "Synthetic sensitivity evidence for EGFR L858R in non-small cell lung cancer.",
        sourceUrl: "https://civicdb.org/evidence/CIVIC-SYN-EGFR-L858R-1",
        rawResponseHash: "d".repeat(64),
        payload: { fixturePack: "somatic-public-synthetic-v1" },
      },
      {
        normalizedVariantId: "GRCh38:7:140753336:A:T",
        sourceRecordId: "CIVIC-SYN-BRAF-V600E-1",
        sourceNativeLevel: "B",
        clinicalDomain: "therapeutic",
        direction: "supporting",
        diseaseOntology: {
          ontologySystem: "GVI-E2E",
          ontologyVersion: "1",
          code: "E2E-MELANOMA",
        },
        summary: "Synthetic therapeutic evidence for BRAF V600E in melanoma.",
        sourceUrl: "https://civicdb.org/evidence/CIVIC-SYN-BRAF-V600E-1",
        rawResponseHash: "e".repeat(64),
        payload: { fixturePack: "somatic-public-synthetic-v1" },
      },
    ].map(record => offlineKnowledgeEvidenceSchema.parse(record));
    await db
      .insert(somaticKnowledgeEvidenceRecords)
      .values(
        offlineRecords.map(record =>
          offlineEvidenceInsertValues(organization.id, release.id, record)
        )
      );
  }
  const [region] = await db
    .insert(somaticPanelReportableRegions)
    .values({
      organizationId: organization.id,
      panelVersionId: panelVersion.id,
      regionKey: "EGFR-exon-21",
      regionType: "exon",
      findingType: null,
      gene: "EGFR",
      chromosome: "7",
      start: 55259400,
      end: 55259600,
      minimumDepth: 20,
      minimumCoveragePercent: "100.00",
      reportable: true,
    })
    .returning();

  const fixtureRows = input.fixtureVariants
    ? [
        {
          normalizedId: "GRCh38:7:55259515:T:G",
          chromosome: "7",
          position: 55259515,
          referenceAllele: "T",
          alternateAllele: "G",
          gene: "EGFR",
          transcript: "NM_005228.5",
          hgvsC: "c.2573T>G",
          hgvsP: "p.Leu858Arg",
          vaf: "0.3100000000",
          readDepth: 420,
          alternateDepth: 130,
        },
        {
          normalizedId: "GRCh38:7:140753336:A:T",
          chromosome: "7",
          position: 140753336,
          referenceAllele: "A",
          alternateAllele: "T",
          gene: "BRAF",
          transcript: "NM_004333.6",
          hgvsC: "c.1799T>A",
          hgvsP: "p.Val600Glu",
          vaf: "0.4200000000",
          readDepth: 380,
          alternateDepth: 160,
        },
        {
          normalizedId: "GRCh38:7:116771993:T:C",
          chromosome: "7",
          position: 116771993,
          referenceAllele: "T",
          alternateAllele: "C",
          gene: "MET",
          transcript: "NM_000245.4",
          hgvsC: "c.3029C>T",
          hgvsP: "p.Thr1010Ile",
          vaf: "0.3000000000",
          readDepth: 12,
          alternateDepth: 4,
        },
      ]
    : [
        {
          normalizedId: "GRCh38:1:100:A:G",
          chromosome: "1",
          position: 100,
          referenceAllele: "A",
          alternateAllele: "G",
          gene: "GUARD",
          transcript: "NM_GUARD.1",
          hgvsC: "c.1A>G",
          hgvsP: "p.Met1Val",
          vaf: "0.2500000000",
          readDepth: 100,
          alternateDepth: 25,
        },
      ];
  const variantRows = await db
    .insert(variants)
    .values(
      fixtureRows.map(row => ({
        organizationId: organization.id,
        caseId: clinicalCase.id,
        referenceBuild: "GRCh38" as const,
        variantType: "SNV" as const,
        consequence: "missense_variant",
        impact: "MODERATE" as const,
        annotation: { callFilter: "PASS", fixture: true },
        ...row,
      }))
    )
    .returning({ id: variants.id });

  return {
    organizationId: organization.id,
    projectId: project.id,
    caseId: clinicalCase.id,
    contextId: context.id,
    panelVersionId: panelVersion.id,
    variantIds: variantRows.map(row => row.id),
    providerId: provider.id,
    releaseId,
    regionId: region.id,
  };
}

function createCaller(user: User) {
  const ctx: TrpcContext = {
    user,
    req: {
      headers: {
        "x-request-id": "somatic-e2e",
        "user-agent": "somatic-e2e.ts",
      },
      ip: "127.0.0.1",
      protocol: "http",
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

async function runWorkflow(db: Db, user: User, seed: Seed) {
  const caller = createCaller(user);
  const queued = await caller.somatic.start({
    organizationId: seed.organizationId,
    caseId: seed.caseId,
  });
  await runSomaticWorkerOnce("somatic-e2e-worker", 60);
  const run = { id: queued.runId };

  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    [completed] = await db
      .select()
      .from(somaticInterpretationRuns)
      .where(eq(somaticInterpretationRuns.id, run.id));
    if (
      completed &&
      ["ready_for_review", "partial", "failed"].includes(completed.status)
    ) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(completed);
  assert.equal(completed.status, "ready_for_review");
  assert.equal(completed.attemptCount, 1);
  assert.equal(completed.leaseOwner, null);
  assert.equal(completed.leaseExpiresAt, null);
  assert.equal(completed.knowledgeVersions.CIVIC, "fixture-guideline-1");
  assert.equal(
    completed.knowledgeVersions["guideline:CIVIC"],
    "fixture-guideline-1"
  );
  assert.equal(
    completed.knowledgeVersions.OncoKB,
    "disabled_pending_configuration"
  );

  const analyses = await db
    .select({
      analysis: somaticVariantAnalyses,
      gene: variants.gene,
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
        eq(somaticVariantAnalyses.organizationId, seed.organizationId),
        eq(somaticVariantAnalyses.runId, run.id)
      )
    );
  assert.equal(analyses.length, 3);
  assert.equal(
    analyses.find(row => row.gene === "EGFR")?.analysis.qcStatus,
    "pass"
  );
  assert.equal(
    analyses.find(row => row.gene === "BRAF")?.analysis.candidate,
    true
  );
  assert.equal(
    analyses.find(row => row.gene === "MET")?.analysis.qcStatus,
    "low_depth"
  );
  assert.deepEqual(
    analyses.find(row => row.gene === "MET")?.analysis.qcReasons,
    ["depth_below_20"]
  );

  const assertionRows = await db
    .select({
      assertion: somaticClinicalAssertions,
      gene: variants.gene,
    })
    .from(somaticClinicalAssertions)
    .innerJoin(
      variants,
      and(
        eq(variants.id, somaticClinicalAssertions.variantId),
        eq(variants.organizationId, somaticClinicalAssertions.organizationId)
      )
    )
    .where(eq(somaticClinicalAssertions.runId, run.id));
  assert.equal(assertionRows.length, 2);
  const egfrProposal = assertionRows.find(
    row => row.gene === "EGFR"
  )?.assertion;
  const brafProposal = assertionRows.find(
    row => row.gene === "BRAF"
  )?.assertion;
  assert.equal(egfrProposal?.systemTier, "Tier I");
  assert.equal(egfrProposal?.systemLevel, "A");
  assert.deepEqual(egfrProposal?.proposalFlags.reasonCodes, [
    "approved_guideline_rule_applied",
  ]);
  assert.equal(
    egfrProposal?.proposalFlags.appliedRule?.recordKey,
    "EGFR-L858R-E2E-NSCLC"
  );
  assert.equal(brafProposal?.systemTier, null);
  assert.deepEqual(brafProposal?.proposalFlags.reasonCodes, [
    "disease_match_requires_review",
    "approved_guideline_rule_missing",
  ]);
  const evidence = await db
    .select()
    .from(somaticEvidenceRecords)
    .where(eq(somaticEvidenceRecords.runId, run.id));
  assert.equal(evidence.length, 2);
  assert.ok(
    evidence.every(
      row =>
        row.sourceName === "CIVIC" &&
        row.sourceVersion === "fixture-guideline-1" &&
        SHA256.test(row.rawResponseHash) &&
        row.payload?.fixturePack === "somatic-public-synthetic-v1"
    )
  );

  const panelArtifactHash = "1".repeat(64);
  const coverageArtifactHash = "2".repeat(64);
  const panelImport = await caller.somaticFoundation.importPanelRegions({
    organizationId: seed.organizationId,
    panelVersionId: seed.panelVersionId,
    artifactName: "synthetic-panel-fixture-v1.regions.json",
    artifactHash: panelArtifactHash,
    regions: [
      {
        regionKey: "EGFR-exon-21",
        regionType: "exon",
        findingType: null,
        gene: "EGFR",
        transcript: "NM_005228.5",
        chromosome: "7",
        start: 55259400,
        end: 55259600,
        target: { exon: 21 },
        minimumDepth: 20,
        minimumCoveragePercent: 100,
        reportable: true,
      },
    ],
  });
  assert.equal(panelImport.reportableRegionCount, 1);
  const validatedPanel = await caller.somaticFoundation.validatePanelRegions({
    organizationId: seed.organizationId,
    panelVersionId: seed.panelVersionId,
    artifactHash: panelArtifactHash,
  });
  assert.equal(validatedPanel.regionValidationStatus, "passed");
  const coverageImport = await caller.somaticFoundation.importCaseCoverage({
    organizationId: seed.organizationId,
    caseId: seed.caseId,
    panelVersionId: seed.panelVersionId,
    artifactHash: coverageArtifactHash,
    qcMetrics: { fixture: true, assay: "synthetic targeted DNA" },
    records: [
      {
        regionKey: "EGFR-exon-21",
        meanDepth: 420,
        coveredPercent: 100,
      },
    ],
  });
  assert.equal(coverageImport.failedRegionCount, 0);
  const coverageValidation =
    await caller.somaticFoundation.validateCoverageSummary({
      organizationId: seed.organizationId,
      coverageSummaryId: coverageImport.summary.id,
      validationArtifactHash: coverageArtifactHash,
    });
  assert.equal(coverageValidation.validation.passed, true);
  const assayFinding = await caller.somaticFoundation.createAssayFinding({
    organizationId: seed.organizationId,
    caseId: seed.caseId,
    panelVersionId: seed.panelVersionId,
    coverageSummaryId: coverageImport.summary.id,
    findingType: "TMB",
    status: "detected",
    result: {
      type: "TMB",
      mutationsPerMb: 14.2,
      category: "high",
    },
    sourceRunId: "synthetic-tmb-fixture-v1",
  });
  const reviewedAssay = await caller.somaticFoundation.reviewAssayFinding({
    organizationId: seed.organizationId,
    findingId: assayFinding.id,
    reportable: true,
  });
  assert.equal(reviewedAssay.finding.reportable, true);
  const egfr = egfrProposal;
  const braf = brafProposal;
  assert.ok(egfr && braf);
  const reviewed = await caller.somatic.reviewAssertion({
    organizationId: seed.organizationId,
    assertionId: egfr.id,
    finalTier: "Tier I",
    finalLevel: "A",
    oncogenicity: "Oncogenic",
    rationale:
      "Synthetic expert review confirms the fixture assertion for lifecycle validation.",
    decision: "save",
  });
  assert.equal(reviewed.status, "in_review");
  const approved = await caller.somatic.reviewAssertion({
    organizationId: seed.organizationId,
    assertionId: egfr.id,
    finalTier: "Tier I",
    finalLevel: "A",
    oncogenicity: "Oncogenic",
    rationale:
      "Synthetic expert review confirms the fixture assertion for lifecycle validation.",
    decision: "approve",
  });
  assert.equal(approved.status, "approved");
  const rejected = await caller.somatic.reviewAssertion({
    organizationId: seed.organizationId,
    assertionId: braf.id,
    finalTier: "Tier IV",
    finalLevel: null,
    oncogenicity: "Not Evaluated",
    rationale:
      "Synthetic expert review rejects this fixture assertion to validate rejection handling.",
    decision: "reject",
  });
  assert.equal(rejected.status, "rejected");

  const draft = await caller.somaticReports.createDraft({
    organizationId: seed.organizationId,
    caseId: seed.caseId,
  });
  const draftPackage = await caller.somaticReports.get({
    organizationId: seed.organizationId,
    reportId: draft.id,
  });
  assert.equal(draftPackage.report.status, "draft");
  assert.equal(
    (draftPackage.report.content as { findings: unknown[] }).findings.length,
    1
  );
  assert.equal(
    (draftPackage.report.content as { assayFindings: unknown[] }).assayFindings
      .length,
    1
  );
  await caller.somaticReports.submitReview({
    organizationId: seed.organizationId,
    reportId: draft.id,
  });
  const signedResult = await caller.somaticReports.sign({
    organizationId: seed.organizationId,
    reportId: draft.id,
    confirmReportId: draft.id,
    attestation: true,
  });
  assert.match(signedResult.snapshotHash, SHA256);
  const [signed] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.id, draft.id),
        eq(reports.organizationId, seed.organizationId)
      )
    );
  assert.equal(signed.status, "signed");
  assert.ok(signed.snapshot);
  assert.equal(signed.snapshotHash, createReportDigest(signed.snapshot).sha256);
  const snapshot = signed.snapshot as {
    schemaVersion: string;
    provenance: Record<string, unknown>;
    interpretationRun: { id: number };
    assayFindings: unknown[];
    coverageSummaries: unknown[];
    signature: { userId: number; role: string };
  };
  assert.equal(snapshot.schemaVersion, "somatic-report-snapshot-3");
  assert.equal(snapshot.interpretationRun.id, run.id);
  assert.equal(snapshot.assayFindings.length, 1);
  assert.equal(snapshot.coverageSummaries.length, 1);
  assert.equal(snapshot.provenance.assembly, "GRCh38");
  assert.equal(snapshot.provenance.pipelineVersion, SOMATIC_PIPELINE_VERSION);
  assert.equal(snapshot.provenance.rulesetVersion, SOMATIC_RUN_RULESET_VERSION);
  assert.deepEqual(
    snapshot.provenance.knowledgeVersions,
    completed.knowledgeVersions
  );
  assert.equal(snapshot.signature.userId, user.id);
  assert.ok(
    ["administrator", "super_administrator"].includes(snapshot.signature.role)
  );

  const amendment = await caller.somaticReports.amend({
    organizationId: seed.organizationId,
    reportId: draft.id,
    reason:
      "Synthetic amendment validates immutable parent and version lineage.",
  });
  const reportRows = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.organizationId, seed.organizationId),
        inArray(reports.id, [draft.id, amendment.id])
      )
    );
  const parent = reportRows.find(row => row.id === draft.id);
  const child = reportRows.find(row => row.id === amendment.id);
  assert.equal(parent?.status, "amended");
  assert.equal(parent?.snapshotHash, signedResult.snapshotHash);
  assert.equal(
    createReportDigest(parent!.snapshot!).sha256,
    signedResult.snapshotHash
  );
  assert.equal(child?.status, "draft");
  assert.equal(child?.parentReportId, draft.id);
  assert.equal(child?.version, 2);

  const nextRelease = await caller.somaticFoundation.createRelease({
    organizationId: seed.organizationId,
    providerId: seed.providerId,
    version: "fixture-guideline-2",
    contentHash: "f".repeat(64),
    sourcePublishedAt: new Date("2026-09-28T00:00:00.000Z"),
    changeControlId: "SOM-E2E-GUIDELINE-2",
    changeSummary:
      "Synthetic second offline release validates case impact task creation.",
  });
  await caller.somaticFoundation.addGuidelineRecord({
    organizationId: seed.organizationId,
    releaseId: nextRelease.id,
    recordKey: "EGFR-L858R-E2E-NSCLC",
    recordVersion: 2,
    title: "Synthetic EGFR L858R review-only proposal rule v2",
    guideline: {
      schemaVersion: 1,
      kind: "somatic_amp_proposal_rule",
      gene: "EGFR",
      normalizedVariantId: "GRCh38:7:55259515:T:G",
      clinicalDomain: "therapeutic",
      tumor: {
        ontologySystem: "GVI-E2E",
        ontologyVersion: "1",
        code: `E2E-${PRIMARY_SLUG}`,
      },
      requiredDirection: "supporting",
      systemTier: "Tier I",
      systemLevel: "A",
    },
    sourceCitation: "Synthetic validation rule v2; not clinical truth.",
    effectiveFrom: null,
    effectiveTo: null,
  });
  await caller.somaticFoundation.importReleaseEvidence({
    organizationId: seed.organizationId,
    releaseId: nextRelease.id,
    records: [
      {
        normalizedVariantId: "GRCh38:7:55259515:T:G",
        sourceRecordId: "CIVIC-SYN-EGFR-L858R-1",
        sourceNativeLevel: "A",
        clinicalDomain: "therapeutic",
        direction: "supporting",
        diseaseOntology: {
          ontologySystem: "GVI-E2E",
          ontologyVersion: "1",
          code: `E2E-${PRIMARY_SLUG}`,
        },
        summary:
          "Updated synthetic EGFR evidence for release impact validation.",
        sourceUrl: "https://civicdb.org/evidence/CIVIC-SYN-EGFR-L858R-1",
        rawResponseHash: "f".repeat(64),
        payload: { fixturePack: "somatic-public-synthetic-v2" },
      },
      {
        normalizedVariantId: "GRCh38:7:140753336:A:T",
        sourceRecordId: "CIVIC-SYN-BRAF-V600E-1",
        sourceNativeLevel: "B",
        clinicalDomain: "therapeutic",
        direction: "supporting",
        diseaseOntology: {
          ontologySystem: "GVI-E2E",
          ontologyVersion: "1",
          code: "E2E-MELANOMA",
        },
        summary: "Synthetic therapeutic evidence for BRAF V600E in melanoma.",
        sourceUrl: "https://civicdb.org/evidence/CIVIC-SYN-BRAF-V600E-1",
        rawResponseHash: "e".repeat(64),
        payload: { fixturePack: "somatic-public-synthetic-v2" },
      },
    ],
  });
  await caller.somaticFoundation.recordReleaseValidation({
    organizationId: seed.organizationId,
    releaseId: nextRelease.id,
    validationStatus: "passed",
    validationSummary: { fixture: true, result: "passed" },
  });
  const impactPreview = await caller.somaticFoundation.previewReleaseImpact({
    organizationId: seed.organizationId,
    releaseId: nextRelease.id,
  });
  assert.equal(impactPreview.currentRelease?.version, "fixture-guideline-1");
  assert.equal(impactPreview.targetRelease.version, "fixture-guideline-2");
  assert.equal(impactPreview.gates.allowed, true);
  assert.equal(impactPreview.impactedCases.length, 1);
  assert.deepEqual(impactPreview.releaseDiff.impactedVariantIds, [
    "GRCh38:7:55259515:T:G",
  ]);
  const activation = await caller.somaticFoundation.activateRelease({
    organizationId: seed.organizationId,
    releaseId: nextRelease.id,
  });
  assert.deepEqual(activation.releaseDiff, {
    added: 0,
    removed: 0,
    changed: 1,
    impactedVariantIds: ["GRCh38:7:55259515:T:G"],
  });
  assert.equal(activation.reinterpretationTaskCount, 1);
  const reinterpretationTasks =
    await caller.somaticFoundation.listReinterpretationTasks({
      organizationId: seed.organizationId,
      caseId: seed.caseId,
    });
  assert.equal(reinterpretationTasks.length, 1);
  assert.equal(
    reinterpretationTasks[0].previousReleaseVersion,
    "fixture-guideline-1"
  );
  assert.equal(
    reinterpretationTasks[0].targetReleaseVersion,
    "fixture-guideline-2"
  );
  const enqueued = await caller.somaticFoundation.enqueueReinterpretationTasks({
    organizationId: seed.organizationId,
    taskIds: [reinterpretationTasks[0].id],
  });
  assert.equal(enqueued.queued, 1);
  assert.equal(enqueued.skipped.length, 0);
  await runSomaticWorkerOnce("somatic-e2e-reinterpretation-worker", 60);
  const inReviewTasks =
    await caller.somaticFoundation.listReinterpretationTasks({
      organizationId: seed.organizationId,
      caseId: seed.caseId,
    });
  assert.equal(inReviewTasks[0].status, "in_review");
  assert.equal(inReviewTasks[0].interpretationRun?.status, "ready_for_review");
  const reinterpretationAssertions = await db
    .select()
    .from(somaticClinicalAssertions)
    .where(eq(somaticClinicalAssertions.runId, enqueued.results[0].runId));
  for (const assertion of reinterpretationAssertions) {
    const approvedProposal = assertion.systemTier === "Tier I";
    await caller.somatic.reviewAssertion({
      organizationId: seed.organizationId,
      assertionId: assertion.id,
      finalTier: approvedProposal ? "Tier I" : "Tier IV",
      finalLevel: approvedProposal ? "A" : null,
      oncogenicity: approvedProposal ? "Oncogenic" : "Not Evaluated",
      rationale:
        "Synthetic Phase 4 expert review validates task completion gates.",
      decision: approvedProposal ? "approve" : "reject",
    });
  }
  await caller.somaticFoundation.updateReinterpretationTask({
    organizationId: seed.organizationId,
    taskId: reinterpretationTasks[0].id,
    status: "completed",
  });
  assert.ok(seed.releaseId);
  const rollback = await caller.somaticFoundation.rollbackRelease({
    organizationId: seed.organizationId,
    releaseId: seed.releaseId,
    changeControlId: "SOM-E2E-ROLLBACK-1",
    reason:
      "Synthetic rollback validates controlled restoration and impact task creation.",
  });
  assert.equal(rollback.rolledBack, true);
  assert.equal(rollback.reinterpretationTaskCount, 1);
  const rollbackTasks =
    await caller.somaticFoundation.listReinterpretationTasks({
      organizationId: seed.organizationId,
      caseId: seed.caseId,
      status: "open",
    });
  assert.equal(rollbackTasks.length, 1);
  assert.equal(rollbackTasks[0].targetReleaseVersion, "fixture-guideline-1");

  return {
    runId: run.id,
    runStatus: completed.status,
    qc: Object.fromEntries(
      analyses.map(row => [
        row.gene ?? String(row.analysis.variantId),
        row.analysis.qcStatus,
      ])
    ),
    assertionStatuses: [reviewed.status, approved.status, rejected.status],
    report: {
      signedReportId: draft.id,
      amendedReportId: amendment.id,
      snapshotHash: signedResult.snapshotHash,
    },
    panelCoverage: {
      regionValidationStatus: validatedPanel.regionValidationStatus,
      coverageValidationStatus: coverageValidation.summary.validationStatus,
      assayFindingCount: 1,
    },
    releaseImpact: {
      ...activation.releaseDiff,
      reinterpretationTaskCount: activation.reinterpretationTaskCount,
    },
  };
}

async function expectViolation(
  client: PoolClient,
  index: number,
  expectedConstraint: string,
  query: string,
  values: unknown[]
) {
  const savepoint = `somatic_e2e_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(query, values);
    assert.fail(`Expected constraint ${expectedConstraint} to reject the row`);
  } catch (error) {
    const dbError = error as { code?: string; constraint?: string };
    assert.ok(
      dbError.code === "23503" ||
        dbError.code === "23505" ||
        dbError.code === "23514",
      `${expectedConstraint}: expected FK/check/unique violation, got ${dbError.code}`
    );
    assert.equal(dbError.constraint, expectedConstraint);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

async function runConstraintChecks(
  pool: Pool,
  primary: Seed,
  guard: Seed,
  user: User
) {
  assert.ok(primary.releaseId);
  const client = await pool.connect();
  try {
    const installed = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      [requiredConstraints]
    );
    assert.deepEqual(
      new Set(installed.rows.map(row => row.conname)),
      new Set(requiredConstraints),
      "Required 0010/0011 constraints are not all installed"
    );

    await client.query("BEGIN");
    let i = 0;
    const violation = (constraint: string, query: string, values: unknown[]) =>
      expectViolation(client, ++i, constraint, query, values);

    const contextProbeCase = await client.query<{ id: number }>(
      `INSERT INTO cases
       ("organizationId", "projectId", "caseNumber", "patientAlias", purpose, "inputType", status, "referenceBuild", "consentClinicalAnalysis", "createdBy")
       VALUES ($1, $2, $3, 'constraint-probe', 'somatic', 'vcf', 'draft', 'GRCh38', true, $4)
       RETURNING id`,
      [
        primary.organizationId,
        primary.projectId,
        `${CASE_NUMBER}-CONSTRAINT`,
        user.id,
      ]
    );
    await violation(
      "somatic_case_contexts_panel_version_org_fk",
      `INSERT INTO somatic_case_contexts
       ("organizationId", "caseId", "primaryTumorTypeId", "panelVersionId", "specimenCollectionSite")
       SELECT $1, $2, "primaryTumorTypeId", $3, 'invalid'
       FROM somatic_case_contexts WHERE id = $4`,
      [
        primary.organizationId,
        contextProbeCase.rows[0].id,
        guard.panelVersionId,
        primary.contextId,
      ]
    );
    await violation(
      "somatic_interpretation_runs_context_org_fk",
      `INSERT INTO somatic_interpretation_runs
       ("organizationId", "caseId", "contextId", status, "pipelineVersion", "rulesetVersion", "knowledgeVersions", "requestedBy")
       VALUES ($1, $2, $3, 'queued', 'e2e', 'e2e', '{}'::jsonb, $4)`,
      [primary.organizationId, primary.caseId, guard.contextId, user.id]
    );

    const insertedRun = await client.query<{ id: number }>(
      `INSERT INTO somatic_interpretation_runs
       ("organizationId", "caseId", "contextId", status, "pipelineVersion", "rulesetVersion", "knowledgeVersions", "requestedBy")
       VALUES ($1, $2, $3, 'queued', 'e2e', 'e2e', '{}'::jsonb, $4)
       RETURNING id`,
      [primary.organizationId, primary.caseId, primary.contextId, user.id]
    );
    await violation(
      "somatic_interpretation_runs_one_active_case_uq",
      `INSERT INTO somatic_interpretation_runs
       ("organizationId", "caseId", "contextId", status, "pipelineVersion", "rulesetVersion", "knowledgeVersions", "requestedBy")
       VALUES ($1, $2, $3, 'queued', 'e2e-duplicate', 'e2e', '{}'::jsonb, $4)`,
      [primary.organizationId, primary.caseId, primary.contextId, user.id]
    );
    await violation(
      "somatic_reinterpretation_tasks_one_open_change_uq",
      `INSERT INTO somatic_reinterpretation_tasks
       ("organizationId", "caseId", "releaseId", status, reason, impact, "targetReleaseVersion", "createdBy")
       VALUES ($1, $2, $3, 'open', 'duplicate phase four task', '{}'::jsonb, 'fixture-guideline-1', $4)`,
      [primary.organizationId, primary.caseId, primary.releaseId, user.id]
    );
    await violation(
      "somatic_variant_analyses_variant_org_fk",
      `INSERT INTO somatic_variant_analyses
       ("organizationId", "runId", "variantId", "qcReasons")
       VALUES ($1, $2, $3, '[]'::jsonb)`,
      [primary.organizationId, insertedRun.rows[0].id, guard.variantIds[0]]
    );
    await violation(
      "somatic_clinical_assertions_proposal_flags_ck",
      `INSERT INTO somatic_clinical_assertions
       ("organizationId", "runId", "variantId", "tumorTypeId", "clinicalDomain", "rulesetVersion", rationale, "evidenceIds", "proposalFlags")
       SELECT $1, $2, $3, "primaryTumorTypeId", 'oncogenicity', 'e2e', 'invalid flags', '[]'::jsonb,
              '{"conflict":"yes","reasonCodes":[],"diseaseMatches":[],"appliedRule":null}'::jsonb
       FROM somatic_case_contexts WHERE id = $4`,
      [
        primary.organizationId,
        insertedRun.rows[0].id,
        primary.variantIds[0],
        primary.contextId,
      ]
    );
    await violation(
      "reports_somatic_template_version_org_fk",
      `INSERT INTO reports
       ("organizationId", "caseId", version, title, content, "somaticTemplateVersionId", "createdBy")
       SELECT $1, $2, 99, 'invalid', '{}'::jsonb, "activeVersionId", $3
       FROM somatic_report_templates WHERE "organizationId" = $4 LIMIT 1`,
      [guard.organizationId, guard.caseId, user.id, primary.organizationId]
    );
    await violation(
      "somatic_knowledge_releases_provider_org_fk",
      `INSERT INTO somatic_knowledge_releases
       ("organizationId", "providerId", version, "contentHash", "changeControlId", "changeSummary", "createdBy")
       VALUES ($1, $2, 'invalid', $3, 'E2E', 'invalid tenant', $4)`,
      [primary.organizationId, guard.providerId, "0".repeat(64), user.id]
    );
    await violation(
      "somatic_knowledge_evidence_records_release_org_fk",
      `INSERT INTO somatic_knowledge_evidence_records
       ("organizationId", "releaseId", "normalizedVariantId", "sourceRecordId", "clinicalDomain", direction, summary, "rawResponseHash", payload)
       VALUES ($1, $2, 'GRCh38:1:1:A:T', 'invalid-tenant', 'therapeutic', 'supporting', 'invalid tenant', $3, '{}'::jsonb)`,
      [guard.organizationId, primary.releaseId, "3".repeat(64)]
    );
    await violation(
      "somatic_knowledge_evidence_records_hash_ck",
      `INSERT INTO somatic_knowledge_evidence_records
       ("organizationId", "releaseId", "normalizedVariantId", "sourceRecordId", "clinicalDomain", direction, summary, "rawResponseHash", payload)
       VALUES ($1, $2, 'GRCh38:1:2:A:T', 'invalid-hash', 'therapeutic', 'supporting', 'invalid hash', 'not-a-hash', '{}'::jsonb)`,
      [primary.organizationId, primary.releaseId]
    );
    await violation(
      "somatic_case_coverage_panel_org_fk",
      `INSERT INTO somatic_case_coverage_summaries
       ("organizationId", "caseId", "panelVersionId", "qcMetrics")
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      [primary.organizationId, primary.caseId, guard.panelVersionId]
    );

    const primaryCoverage = await client.query<{ id: number }>(
      `SELECT id FROM somatic_case_coverage_summaries
       WHERE "organizationId" = $1 AND "caseId" = $2 AND "panelVersionId" = $3`,
      [primary.organizationId, primary.caseId, primary.panelVersionId]
    );
    const guardCoverage = await client.query<{ id: number }>(
      `INSERT INTO somatic_case_coverage_summaries
       ("organizationId", "caseId", "panelVersionId", "qcMetrics")
       VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
      [guard.organizationId, guard.caseId, guard.panelVersionId]
    );
    await violation(
      "somatic_case_region_coverage_region_org_fk",
      `INSERT INTO somatic_case_region_coverage
       ("organizationId", "coverageSummaryId", "panelRegionId", "qcPassed", "qcReasons")
       VALUES ($1, $2, $3, true, '[]'::jsonb)`,
      [primary.organizationId, primaryCoverage.rows[0].id, guard.regionId]
    );
    await violation(
      "somatic_assay_findings_coverage_org_fk",
      `INSERT INTO somatic_assay_findings
       ("organizationId", "caseId", "panelVersionId", "coverageSummaryId", "findingType", status, reportable, "reportabilityReasons")
       VALUES ($1, $2, $3, $4, 'MSI', 'indeterminate', false, '[]'::jsonb)`,
      [
        primary.organizationId,
        primary.caseId,
        primary.panelVersionId,
        guardCoverage.rows[0].id,
      ]
    );
    await violation(
      "somatic_knowledge_releases_activation_ck",
      `INSERT INTO somatic_knowledge_releases
       ("organizationId", "providerId", version, status, "validationStatus", "contentHash", "changeControlId", "changeSummary", "createdBy")
       VALUES ($1, $2, 'invalid-active', 'active', 'pending', $3, 'E2E', 'invalid activation', $4)`,
      [primary.organizationId, primary.providerId, "1".repeat(64), user.id]
    );
    await violation(
      "somatic_case_coverage_validation_ck",
      `INSERT INTO somatic_case_coverage_summaries
       ("organizationId", "caseId", "panelVersionId", "validationStatus", "completeRegionCount", "expectedRegionCount", "qcMetrics")
       VALUES ($1, $2, $3, 'passed', 0, 1, '{}'::jsonb)`,
      [primary.organizationId, primary.caseId, primary.panelVersionId]
    );
    await violation(
      "somatic_assay_findings_negative_reportable_ck",
      `INSERT INTO somatic_assay_findings
       ("organizationId", "caseId", "panelVersionId", "findingType", status, reportable, "reportabilityReasons")
       VALUES ($1, $2, $3, 'MSI', 'not_detected', true, '[]'::jsonb)`,
      [primary.organizationId, primary.caseId, primary.panelVersionId]
    );
    await violation(
      "somatic_policy_profiles_activation_ck",
      `INSERT INTO somatic_organization_policy_profiles
       ("organizationId", name, version, status, policy, "contentHash", "changeControlId", "createdBy")
       VALUES ($1, 'invalid-active', 1, 'active', '{}'::jsonb, $2, 'E2E', $3)`,
      [primary.organizationId, "2".repeat(64), user.id]
    );
    await violation(
      "somatic_panel_versions_region_validation_ck",
      `UPDATE somatic_panel_versions
       SET "regionValidationStatus" = 'passed'
       WHERE id = $1 AND "organizationId" = $2`,
      [guard.panelVersionId, guard.organizationId]
    );
    await violation(
      "somatic_case_coverage_source_hash_ck",
      `UPDATE somatic_case_coverage_summaries
       SET "sourceArtifactHash" = 'invalid-hash'
       WHERE id = $1 AND "organizationId" = $2`,
      [guardCoverage.rows[0].id, guard.organizationId]
    );
    await violation(
      "somatic_interpretation_runs_attempts_ck",
      `UPDATE somatic_interpretation_runs
       SET "maxAttempts" = 0
       WHERE id = $1 AND "organizationId" = $2`,
      [insertedRun.rows[0].id, primary.organizationId]
    );
    await client.query("ROLLBACK");
    return {
      installed: requiredConstraints.length,
      deliberateViolationsRolledBack: i,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const command = process.argv[2] ?? "all";
  if (
    !["all", "workflow", "constraints", "browser-seed", "cleanup"].includes(
      command
    )
  ) {
    throw new Error(
      "Usage: tsx scripts/somatic-e2e.ts [all|workflow|constraints|browser-seed|cleanup]"
    );
  }
  const pool = new Pool({ connectionString: databaseUrl() });
  const db = drizzle(pool);
  let succeeded = false;
  try {
    await cleanupDedicatedData(pool);
    if (command === "cleanup") {
      console.log("OK — dedicated somatic E2E data removed");
      succeeded = true;
      return;
    }
    const user =
      command === "browser-seed"
        ? await browserValidationUser(db)
        : await ensureUser(db);
    const primary = await seedOrganization(db, user, {
      slug: PRIMARY_SLUG,
      name: "Somatic E2E Validation",
      caseNumber: CASE_NUMBER,
      fixtureVariants: true,
    });
    const guard = await seedOrganization(db, user, {
      slug: GUARD_SLUG,
      name: "Somatic E2E Constraint Guard",
      caseNumber: "SOM-E2E-GUARD",
      fixtureVariants: false,
    });
    const result: Record<string, unknown> = {
      provider:
        "version-pinned synthetic offline CIViC release (no live network)",
      organizations: [PRIMARY_SLUG, GUARD_SLUG],
    };
    if (
      command === "all" ||
      command === "workflow" ||
      command === "browser-seed"
    ) {
      result.workflow = await runWorkflow(db, user, primary);
    }
    if (command === "all" || command === "constraints") {
      // Materialize the published template through the API so the 0010 report
      // composite-FK probe is valid in standalone `constraints` mode too.
      await createCaller(user).somaticReports.templates({
        organizationId: primary.organizationId,
      });
      result.constraints = await runConstraintChecks(
        pool,
        primary,
        guard,
        user
      );
    }
    console.log(JSON.stringify(result, null, 2));
    console.log("\nOK — somatic E2E validation passed");
    succeeded = true;
  } finally {
    if (command !== "browser-seed" || !succeeded) {
      await cleanupDedicatedData(pool);
    }
    await pool.end();
    if (!succeeded) {
      console.error(
        "Somatic E2E failed; dedicated data cleanup was attempted."
      );
    }
  }
}

await main();

/**
 * End-to-end check for the triage pass.
 *
 *   pnpm exec tsx scripts/triage-e2e.ts
 *
 * Seeds a case with variants that should land in each tier, runs the real pass
 * against Postgres, and asserts the tiers and the panel-gene boost.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  cases,
  organizationMembers,
  organizations,
  projects,
  users,
  variants,
} from "../drizzle/schema";
import { runTriagePass } from "../server/domain/triagePass";

const SLUG = "e2e-triage";
const CASE_NUMBER = "E2E-TRIAGE-001";

/** One variant per expected outcome, so a tier regression is unambiguous. */
const FIXTURES = [
  {
    label: "panel gene, HIGH impact, splice acceptor, ultra-rare",
    expect: "t1_curate",
    gene: "SCN1A",
    hgvsC: "c.1234-1G>A",
    consequence: "splice_acceptor_variant",
    impact: "HIGH" as const,
    populationAf: "0.0000010000",
    clinvarSignificance: null,
  },
  {
    label: "ClinVar pathogenic but common (founder variant)",
    expect: "t1_curate",
    gene: "HFE",
    hgvsC: "c.845G>A",
    consequence: "missense_variant",
    impact: "MODERATE" as const,
    populationAf: "0.0400000000",
    clinvarSignificance: "Pathogenic",
  },
  {
    label: "off-panel missense, moderately rare",
    expect: "t2_review",
    gene: "TTN",
    hgvsC: "c.5000A>G",
    consequence: "missense_variant",
    impact: "MODERATE" as const,
    populationAf: "0.0000500000",
    clinvarSignificance: null,
  },
  {
    label: "common HIGH impact with no ClinVar support",
    expect: "t3_filtered",
    gene: "MUC16",
    hgvsC: "c.100C>T",
    consequence: "stop_gained",
    impact: "HIGH" as const,
    populationAf: "0.1200000000",
    clinvarSignificance: null,
  },
  {
    label: "ClinVar benign",
    expect: "t3_filtered",
    gene: "BRCA2",
    hgvsC: "c.1114A>C",
    consequence: "missense_variant",
    impact: "MODERATE" as const,
    populationAf: "0.0020000000",
    clinvarSignificance: "Benign",
  },
  {
    label: "synonymous, nothing going for it",
    expect: "t3_filtered",
    gene: "ACTB",
    hgvsC: "c.300T>C",
    consequence: "synonymous_variant",
    impact: "LOW" as const,
    populationAf: "0.0030000000",
    clinvarSignificance: null,
  },
  {
    label: "missing HGVS, engine cannot address it",
    expect: "t2_review",
    gene: "NEB",
    hgvsC: null,
    consequence: "intron_variant",
    impact: "MODIFIER" as const,
    populationAf: null,
    clinvarSignificance: null,
  },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const conn = drizzle(process.env.DATABASE_URL);

  const [user] = await conn.select().from(users).orderBy(users.id).limit(1);
  if (!user) throw new Error("No users yet — sign in once so a user row exists");

  let [organization] = await conn.select().from(organizations).where(eq(organizations.slug, SLUG));
  if (!organization) {
    [organization] = await conn
      .insert(organizations)
      .values({ name: "E2E Triage", slug: SLUG, dataRegion: "KR", createdBy: user.id })
      .returning();
  }

  // See the note in curation-e2e.ts: the dev login mints a user per email, so every
  // local account is admitted rather than just the first one.
  const allUsers = await conn.select({ id: users.id }).from(users);
  await conn
    .insert(organizationMembers)
    .values(
      allUsers.map(row => ({
        organizationId: organization.id,
        userId: row.id,
        role: "administrator" as const,
        status: "active" as const,
      }))
    )
    .onConflictDoNothing();

  let [project] = await conn
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organization.id), eq(projects.code, "E2ET")));
  if (!project) {
    [project] = await conn
      .insert(projects)
      .values({
        organizationId: organization.id,
        name: "E2E Triage",
        code: "E2ET",
        createdBy: user.id,
      })
      .returning();
  }

  let [clinicalCase] = await conn
    .select()
    .from(cases)
    .where(and(eq(cases.organizationId, organization.id), eq(cases.caseNumber, CASE_NUMBER)));
  if (!clinicalCase) {
    [clinicalCase] = await conn
      .insert(cases)
      .values({
        organizationId: organization.id,
        projectId: project.id,
        caseNumber: CASE_NUMBER,
        patientAlias: "E2E Triage Proband",
        purpose: "germline",
        inputType: "vcf",
        referenceBuild: "GRCh38",
        // Panel membership must boost SCN1A above the curation threshold.
        panelName: "Epilepsy panel: SCN1A, KCNQ2, STXBP1",
        indication: "Infantile spasms",
        consentClinicalAnalysis: true,
        createdBy: user.id,
      })
      .returning();
  }

  // Rebuild the variant set so tiers are computed from a known starting point.
  await conn
    .delete(variants)
    .where(
      and(eq(variants.organizationId, organization.id), eq(variants.caseId, clinicalCase.id))
    );

  await conn.insert(variants).values(
    FIXTURES.map((fixture, index) => ({
      organizationId: organization.id,
      caseId: clinicalCase.id,
      normalizedId: `GRCh38-1-${100000 + index}-A-G`,
      referenceBuild: "GRCh38" as const,
      chromosome: "1",
      position: 100000 + index,
      referenceAllele: "A",
      alternateAllele: "G",
      variantType: "SNV" as const,
      gene: fixture.gene,
      hgvsC: fixture.hgvsC,
      consequence: fixture.consequence,
      impact: fixture.impact,
      populationAf: fixture.populationAf,
      clinvarSignificance: fixture.clinvarSignificance,
    }))
  );

  const result = await runTriagePass(organization.id, clinicalCase.id);

  const rows = await conn
    .select({
      gene: variants.gene,
      tier: variants.triageTier,
      score: variants.triageScore,
      reasons: variants.triageReasons,
      triagedAt: variants.triagedAt,
    })
    .from(variants)
    .where(and(eq(variants.organizationId, organization.id), eq(variants.caseId, clinicalCase.id)))
    .orderBy(variants.position);

  const failures: string[] = [];
  rows.forEach((row, index) => {
    const fixture = FIXTURES[index];
    if (row.tier !== fixture.expect) {
      failures.push(`${fixture.gene} (${fixture.label}): got ${row.tier}, expected ${fixture.expect}`);
    }
    if (!row.triagedAt) failures.push(`${fixture.gene}: triagedAt was not set`);
    if (!row.reasons?.length) failures.push(`${fixture.gene}: no triage reasons recorded`);
  });

  const scn1a = rows.find(row => row.gene === "SCN1A");
  if (!scn1a?.reasons?.some(reason => reason.includes("panel"))) {
    failures.push("SCN1A did not record the panel-gene rule");
  }

  console.log(
    JSON.stringify(
      {
        pass: result,
        variants: rows.map((row, index) => ({
          gene: row.gene,
          expect: FIXTURES[index].expect,
          tier: row.tier,
          score: row.score,
          reasons: row.reasons,
        })),
      },
      null,
      2
    )
  );

  if (failures.length) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nOK — triage pass assigned every expected tier");
}

await main();
process.exit(0);

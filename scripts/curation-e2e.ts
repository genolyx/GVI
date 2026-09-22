/**
 * End-to-end check for the curation queue.
 *
 *   pnpm exec tsx scripts/curation-e2e.ts seed     # create fixtures + queue a run
 *   pnpm exec tsx scripts/curation-e2e.ts verify   # assert the run completed
 *   pnpm exec tsx scripts/curation-e2e.ts reap     # assert expired leases recover
 *
 * The worker half is driven by `engine/tests/e2e_fake_worker.py`, which uses the
 * real Python API client and the real adapter but replays a regression baseline
 * instead of running the engine. That keeps the check fast and offline while still
 * exercising claim → lease → upload → complete against real Postgres and MinIO.
 */
import "dotenv/config";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { reapExpiredCurationLeases } from "../server/domain/curationQueue";
import {
  cases,
  criteriaAssessments,
  curationRunEvents,
  curationRuns,
  evidenceItems,
  interpretations,
  organizationMembers,
  organizations,
  projects,
  users,
  variants,
} from "../drizzle/schema";

const SLUG = "e2e-curation";
const CASE_NUMBER = "E2E-CURATION-001";
/** Matches the AMT regression baseline the fake worker replays. */
const VARIANT = {
  normalizedId: "GRCh38-3-49416424-C-T",
  chromosome: "3",
  position: 49416424,
  referenceAllele: "C",
  alternateAllele: "T",
  gene: "AMT",
  transcript: "NM_000481.4",
  hgvsC: "c.878-1G>A",
  consequence: "splice_acceptor_variant",
};

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return drizzle(process.env.DATABASE_URL);
}

async function seed() {
  const conn = db();

  const [user] = await conn.select().from(users).orderBy(users.id).limit(1);
  if (!user) throw new Error("No users yet — sign in once so a user row exists");

  let [organization] = await conn.select().from(organizations).where(eq(organizations.slug, SLUG));
  if (!organization) {
    [organization] = await conn
      .insert(organizations)
      .values({ name: "E2E Curation", slug: SLUG, dataRegion: "KR", createdBy: user.id })
      .returning();
  }

  // Every local dev account gets in. The dev login mints a user per email typed, so
  // granting only the first user leaves anyone who logged in with a different address
  // staring at the "create a workspace" screen instead of the fixture.
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
    .where(and(eq(projects.organizationId, organization.id), eq(projects.code, "E2E")));
  if (!project) {
    [project] = await conn
      .insert(projects)
      .values({
        organizationId: organization.id,
        name: "E2E",
        code: "E2E",
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
        patientAlias: "E2E Proband",
        purpose: "germline",
        inputType: "vcf",
        referenceBuild: "GRCh38",
        indication: "Neonatal hypotonia",
        consentClinicalAnalysis: true,
        createdBy: user.id,
      })
      .returning();
  }

  let [variant] = await conn
    .select()
    .from(variants)
    .where(
      and(
        eq(variants.organizationId, organization.id),
        eq(variants.caseId, clinicalCase.id),
        eq(variants.normalizedId, VARIANT.normalizedId)
      )
    );
  if (!variant) {
    [variant] = await conn
      .insert(variants)
      .values({
        organizationId: organization.id,
        caseId: clinicalCase.id,
        referenceBuild: "GRCh38",
        variantType: "SNV",
        impact: "HIGH",
        ...VARIANT,
      })
      .returning();
  }

  // Clear any prior run so the partial unique index does not dedupe this one, and
  // any prior interpretation so the merge is exercised from scratch rather than
  // reusing the draft a previous seed left behind.
  await conn
    .delete(curationRuns)
    .where(
      and(eq(curationRuns.organizationId, organization.id), eq(curationRuns.variantId, variant.id))
    );
  await conn
    .delete(interpretations)
    .where(
      and(
        eq(interpretations.organizationId, organization.id),
        eq(interpretations.variantId, variant.id)
      )
    );

  const [run] = await conn
    .insert(curationRuns)
    .values({
      organizationId: organization.id,
      caseId: clinicalCase.id,
      variantId: variant.id,
      priority: 100,
      requestedBy: user.id,
      input: {
        gene: VARIANT.gene,
        hgvsC: VARIANT.hgvsC,
        transcript: VARIANT.transcript,
        hgvsP: null,
        clinicalNotes: "Neonatal hypotonia",
        referenceBuild: "GRCh38",
        runLiterature: false,
      },
    })
    .returning();

  console.log(
    JSON.stringify(
      {
        organizationId: organization.id,
        caseId: clinicalCase.id,
        variantId: variant.id,
        runId: run.id,
        status: run.status,
      },
      null,
      2
    )
  );
}

async function verify() {
  const conn = db();
  const [organization] = await conn
    .select()
    .from(organizations)
    .where(eq(organizations.slug, SLUG));
  if (!organization) throw new Error("Seed has not run");

  const [run] = await conn
    .select()
    .from(curationRuns)
    .where(eq(curationRuns.organizationId, organization.id))
    .orderBy(desc(curationRuns.id))
    .limit(1);
  if (!run) throw new Error("No curation run found");

  const events = await conn
    .select({
      status: curationRunEvents.status,
      message: curationRunEvents.message,
      progressPercent: curationRunEvents.progressPercent,
    })
    .from(curationRunEvents)
    .where(
      and(
        eq(curationRunEvents.organizationId, organization.id),
        eq(curationRunEvents.runId, run.id)
      )
    )
    .orderBy(curationRunEvents.id);

  const failures: string[] = [];
  if (run.status !== "succeeded") failures.push(`status is ${run.status}, expected succeeded`);
  if (run.attempt !== 1) failures.push(`attempt is ${run.attempt}, expected 1`);
  if (run.leaseExpiresAt !== null) failures.push("lease was not released");
  if (!run.documentKey) failures.push("documentKey missing");
  if (!run.rawKey) failures.push("rawKey missing");
  if (!/^[0-9a-f]{64}$/.test(run.documentHash ?? "")) failures.push("documentHash is not a sha256");
  if (run.summary?.classification?.label !== "Likely Pathogenic") {
    failures.push(`summary classification is ${run.summary?.classification?.label}`);
  }
  if (!run.summary?.criteriaCodes?.includes("PVS1_Strong")) {
    failures.push("summary is missing the engine's PVS1_Strong criterion");
  }
  if (run.contractVersion !== "1.0") failures.push(`contractVersion is ${run.contractVersion}`);

  // M3: the engine's criteria and evidence must land on a draft interpretation
  // marked as engine-authored, with no reviewer attributed to them.
  const [interpretation] = await conn
    .select()
    .from(interpretations)
    .where(
      and(
        eq(interpretations.organizationId, organization.id),
        eq(interpretations.variantId, run.variantId!)
      )
    )
    .orderBy(desc(interpretations.version))
    .limit(1);
  const merged = interpretation
    ? await conn
        .select()
        .from(criteriaAssessments)
        .where(
          and(
            eq(criteriaAssessments.organizationId, organization.id),
            eq(criteriaAssessments.interpretationId, interpretation.id)
          )
        )
        .orderBy(criteriaAssessments.code)
    : [];
  const evidence = await conn
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.organizationId, organization.id),
        eq(evidenceItems.curationRunId, run.id)
      )
    );

  if (!interpretation) failures.push("engine did not open a draft interpretation");
  if (interpretation && interpretation.status !== "draft") {
    failures.push(`interpretation status is ${interpretation.status}, expected draft`);
  }
  if (interpretation && interpretation.origin !== "engine") {
    failures.push(`interpretation origin is ${interpretation.origin}, expected engine`);
  }
  if (interpretation && interpretation.germlineClassification !== null) {
    failures.push("engine must not set a germline classification");
  }
  const pvs1 = merged.find(item => item.code === "PVS1");
  if (!pvs1) failures.push("PVS1 was not merged");
  // The engine emitted PVS1_Strong; the suffix must survive as a strength override.
  if (pvs1 && pvs1.strengthOverride !== "strong") {
    failures.push(`PVS1 strengthOverride is ${pvs1.strengthOverride}, expected strong`);
  }
  if (pvs1 && pvs1.origin !== "engine") failures.push(`PVS1 origin is ${pvs1.origin}`);
  if (pvs1 && pvs1.updatedBy !== null) failures.push("engine criterion must have no updatedBy");
  if (!evidence.length) failures.push("no engine evidence rows were written");
  if (evidence.some(item => item.createdBy !== null)) {
    failures.push("engine evidence must have no createdBy");
  }

  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        attempt: run.attempt,
        engineVersion: run.engineVersion,
        contractVersion: run.contractVersion,
        documentKey: run.documentKey,
        documentHash: run.documentHash,
        rawKey: run.rawKey,
        summary: {
          gene: run.summary?.gene,
          hgvsC: run.summary?.hgvsC,
          classification: run.summary?.classification,
          criteriaCodes: run.summary?.criteriaCodes,
          spliceAiMax: run.summary?.spliceAiMax,
        },
        timings: run.timings,
        merge: {
          interpretationId: interpretation?.id ?? null,
          interpretationStatus: interpretation?.status ?? null,
          interpretationOrigin: interpretation?.origin ?? null,
          criteria: merged.map(item => ({
            code: item.code,
            state: item.state,
            strengthOverride: item.strengthOverride,
            origin: item.origin,
            updatedBy: item.updatedBy,
          })),
          evidence: evidence.map(item => ({ source: item.source, origin: item.origin })),
        },
        events,
      },
      null,
      2
    )
  );

  if (failures.length) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nOK — curation run completed end to end");
}

/**
 * Drive the reaper directly: park a run in `running` with a lease that already
 * lapsed, once with retries left and once exhausted, and assert both recover.
 */
async function reap() {
  const conn = db();
  const [organization] = await conn
    .select()
    .from(organizations)
    .where(eq(organizations.slug, SLUG));
  if (!organization) throw new Error("Seed has not run");

  const expiredLease = sql`now() - interval '1 minute'`;
  const stale = (attempt: number, maxAttempts: number) => ({
    organizationId: organization.id,
    status: "running" as const,
    workerId: "reaper-e2e",
    leaseExpiresAt: expiredLease,
    attempt,
    maxAttempts,
    input: {
      gene: VARIANT.gene,
      hgvsC: VARIANT.hgvsC,
      transcript: VARIANT.transcript,
      hgvsP: null,
      clinicalNotes: null,
      referenceBuild: "GRCh38" as const,
      runLiterature: false,
    },
  });

  // Ad-hoc runs (null variantId) sidestep the active-variant unique index, so both
  // fixtures can sit in `running` at once.
  const [retryable, exhausted] = await conn
    .insert(curationRuns)
    .values([stale(1, 3), stale(3, 3)])
    .returning({ id: curationRuns.id });

  const result = await reapExpiredCurationLeases();

  const [afterRetryable] = await conn
    .select()
    .from(curationRuns)
    .where(eq(curationRuns.id, retryable.id));
  const [afterExhausted] = await conn
    .select()
    .from(curationRuns)
    .where(eq(curationRuns.id, exhausted.id));

  const failures: string[] = [];
  if (afterRetryable.status !== "queued") {
    failures.push(`retryable run is ${afterRetryable.status}, expected queued`);
  }
  if (afterRetryable.workerId !== null || afterRetryable.leaseExpiresAt !== null) {
    failures.push("requeued run still holds a worker or lease");
  }
  if (afterExhausted.status !== "failed") {
    failures.push(`exhausted run is ${afterExhausted.status}, expected failed`);
  }
  if (afterExhausted.error?.kind !== "lease_expired") {
    failures.push(`exhausted run error kind is ${afterExhausted.error?.kind}`);
  }

  await conn.delete(curationRuns).where(inArray(curationRuns.id, [retryable.id, exhausted.id]));

  console.log(
    JSON.stringify(
      {
        reaped: result,
        retryable: { id: retryable.id, status: afterRetryable.status, attempt: afterRetryable.attempt },
        exhausted: {
          id: exhausted.id,
          status: afterExhausted.status,
          error: afterExhausted.error?.kind,
        },
      },
      null,
      2
    )
  );

  if (failures.length) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nOK — expired leases requeued and exhausted runs failed");
}

const command = process.argv[2];
const action =
  command === "seed" ? seed : command === "verify" ? verify : command === "reap" ? reap : null;
if (!action) {
  console.error("Usage: tsx scripts/curation-e2e.ts <seed|verify|reap>");
  process.exit(1);
}
await action();
process.exit(0);

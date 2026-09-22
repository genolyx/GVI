import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { cases, curationRuns, organizations, variants } from "../drizzle/schema";

async function main() {
  const db = drizzle(process.env.DATABASE_URL!);
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, "e2e-curation"));
  console.log("org:", org && { id: org.id, name: org.name });
  if (!org) return;
  const runs = await db
    .select({
      id: curationRuns.id,
      status: curationRuns.status,
      input: curationRuns.input,
      key: curationRuns.documentKey,
      variantId: curationRuns.variantId,
      caseId: curationRuns.caseId,
    })
    .from(curationRuns)
    .where(eq(curationRuns.organizationId, org.id))
    .orderBy(desc(curationRuns.id))
    .limit(8);
  console.log("runs:", runs);
  console.log(
    "variants:",
    await db
      .select({ id: variants.id, gene: variants.gene, hgvs: variants.hgvsC, caseId: variants.caseId })
      .from(variants)
      .where(eq(variants.organizationId, org.id))
  );
  console.log(
    "cases:",
    await db
      .select({ id: cases.id, num: cases.caseNumber })
      .from(cases)
      .where(eq(cases.organizationId, org.id))
  );
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error);
    process.exit(1);
  }
);

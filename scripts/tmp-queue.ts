import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { curationRuns, organizations, users } from "../drizzle/schema";

/** Queue an ad-hoc run for the NLRP3 baseline so the fake worker can fill it. */
async function main() {
  const db = drizzle(process.env.DATABASE_URL!);
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, "e2e-curation"));
  const [user] = await db.select().from(users).limit(1);
  const [run] = await db
    .insert(curationRuns)
    .values({
      organizationId: org.id,
      status: "queued",
      priority: 10,
      input: {
        gene: "NLRP3",
        hgvsC: "c.2798G>T",
        hgvsP: null,
        transcript: null,
        clinicalNotes: null,
        runLiterature: false,
        referenceBuild: "GRCh38",
      },
      requestedBy: user.id,
    })
    .returning({ id: curationRuns.id });
  console.log("queued run", run.id, "in org", org.id);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });

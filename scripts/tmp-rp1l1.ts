import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { curationRuns, variants } from "../drizzle/schema";

async function main() {
  const db = drizzle(process.env.DATABASE_URL!);
  const rows = await db
    .select({
      id: variants.id,
      gene: variants.gene,
      hgvsC: variants.hgvsC,
      hgvsP: variants.hgvsP,
      transcript: variants.transcript,
      populationAf: variants.populationAf,
      clinvar: variants.clinvarSignificance,
    })
    .from(variants)
    .where(eq(variants.caseId, 57));
  const rp = rows.filter(row => row.gene === "RP1L1");
  console.log("variants", rp);

  const runs = await db
    .select({
      id: curationRuns.id,
      status: curationRuns.status,
      variantId: curationRuns.variantId,
      gene: sql<string>`${curationRuns.input}->>'gene'`,
      hgvs: sql<string>`${curationRuns.input}->>'hgvsC'`,
      summary: curationRuns.summary,
    })
    .from(curationRuns)
    .where(eq(curationRuns.caseId, 57));
  for (const run of runs.filter(run => run.gene === "RP1L1")) {
    const summary = (run.summary ?? {}) as {
      classification?: string;
      gnomadAf?: number | null;
      clinvarSignificance?: string | null;
    };
    console.log("run", run.id, run.status, run.hgvs, summary);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

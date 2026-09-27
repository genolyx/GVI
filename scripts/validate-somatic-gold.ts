import { resolve } from "node:path";
import { ZodError } from "zod";
import { loadSomaticExpertGoldPack } from "../server/domain/somatic/expertGold";

const inputPath = process.argv.slice(2).find(argument => argument !== "--");

if (!inputPath) {
  console.error(
    "Usage: pnpm validate:somatic-gold -- <path-to-expert-gold-manifest.json>"
  );
  process.exit(2);
}

try {
  const path = resolve(process.cwd(), inputPath);
  const pack = await loadSomaticExpertGoldPack(path);
  const variants = pack.cases.flatMap(clinicalCase => clinicalCase.variants);
  const reviewStatuses = variants.reduce<Record<string, number>>(
    (counts, variant) => {
      counts[variant.reviewStatus] = (counts[variant.reviewStatus] ?? 0) + 1;
      return counts;
    },
    {}
  );

  console.log(
    JSON.stringify(
      {
        valid: true,
        packVersion: pack.packVersion,
        status: pack.status,
        baseline: pack.baseline,
        panelVersions: pack.panelVersions.length,
        cases: pack.cases.length,
        variants: variants.length,
        reviewStatuses,
        coverageArtifactsReady: pack.panelVersions.every(
          panel =>
            panel.reportableRegionsArtifactHash &&
            panel.coverageValidationArtifactHash
        ),
      },
      null,
      2
    )
  );
} catch (error) {
  if (error instanceof ZodError) {
    console.error(
      JSON.stringify(
        {
          valid: false,
          issues: error.issues.map(issue => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        null,
        2
      )
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}


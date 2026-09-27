import { readFile } from "node:fs/promises";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hash.");
const safeIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Use a pseudonymous identifier containing only letters, numbers, dot, underscore, or hyphen."
  );
const relativeVcfPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(value => !value.startsWith("/") && !value.includes(".."), {
    message: "VCF paths must be relative and cannot traverse parent folders.",
  })
  .refine(value => /\.vcf(?:\.gz)?$/i.test(value), {
    message: "VCF paths must end in .vcf or .vcf.gz.",
  });

const ampTier = z.enum(["Tier I", "Tier II", "Tier III", "Tier IV"]);
const ampLevel = z.enum(["A", "B", "C", "D"]);

const expectedVariantSchema = z
  .object({
    variantId: z
      .string()
      .trim()
      .regex(
        /^GRCh(?:37|38):(?:chr)?[A-Za-z0-9]+:\d+:[ACGTN]+:[ACGTN]+$/i,
        "Use GRCh37/38:chromosome:position:reference:alternate."
      ),
    gene: z.string().trim().min(1).max(80),
    transcript: z.string().trim().min(1).max(120).nullable(),
    hgvsC: z.string().trim().min(1).max(240).nullable(),
    hgvsP: z.string().trim().min(1).max(240).nullable(),
    normalizationStatus: z.enum(["accepted", "manual_review", "rejected"]),
    qcStatus: z.enum([
      "pass",
      "low_vaf",
      "low_depth",
      "build_mismatch",
      "manual_review",
    ]),
    candidate: z.boolean(),
    oncogenicity: z.enum([
      "Oncogenic",
      "Likely Oncogenic",
      "VUS",
      "Likely Benign",
      "Benign",
      "Not Evaluated",
    ]),
    clinicalDomain: z.enum([
      "oncogenicity",
      "therapeutic",
      "diagnostic",
      "prognostic",
    ]),
    clinicalEffect: z.enum([
      "sensitivity",
      "resistance",
      "diagnostic_support",
      "diagnostic_exclusion",
      "favorable_prognosis",
      "unfavorable_prognosis",
      "oncogenic",
      "neutral",
      "unknown",
    ]),
    finalAmpTier: ampTier.nullable(),
    finalAmpLevel: ampLevel.nullable(),
    reportable: z.boolean(),
    rationale: z.string().trim().min(20).max(12_000),
    evidenceRecordIds: z.array(z.string().trim().min(1).max(240)).max(200),
    reviewStatus: z.enum(["draft", "reviewed", "adjudicated"]),
    reviewerIds: z.array(safeIdentifier).min(1).max(20),
    reviewedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.finalAmpTier === "Tier I" ||
        value.finalAmpTier === "Tier II") &&
      value.finalAmpLevel === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["finalAmpLevel"],
        message: "Tier I/II expert gold requires a final AMP level.",
      });
    }
    if (
      (value.finalAmpTier === "Tier III" ||
        value.finalAmpTier === "Tier IV" ||
        value.finalAmpTier === null) &&
      value.finalAmpLevel !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["finalAmpLevel"],
        message: "AMP levels are only accepted with Tier I or Tier II.",
      });
    }
  });

const goldCaseSchema = z
  .object({
    id: safeIdentifier,
    vcf: relativeVcfPath,
    tumor: z
      .object({
        ontologySystem: z.string().trim().min(1).max(40),
        ontologyVersion: z.string().trim().min(1).max(80),
        code: z.string().trim().min(1).max(80),
        label: z.string().trim().min(1).max(255),
      })
      .strict(),
    panelVersionKey: safeIdentifier,
    variants: z.array(expectedVariantSchema).min(1).max(10_000),
  })
  .strict();

export const somaticExpertGoldSchema = z
  .object({
    schemaVersion: z.literal(1),
    packVersion: safeIdentifier,
    status: z.enum(["draft", "final"]),
    createdAt: z.string().datetime(),
    deidentified: z.literal(true),
    baseline: z.literal("AMP_ASCO_CAP_2017"),
    institutionPolicyVersion: z.string().trim().min(1).max(160),
    panelVersions: z
      .array(
        z
          .object({
            key: safeIdentifier,
            manufacturer: z.string().trim().min(1).max(160),
            name: z.string().trim().min(1).max(200),
            version: z.string().trim().min(1).max(120),
            genomeBuild: z.enum(["GRCh37", "GRCh38"]),
            reportableRegionsArtifactHash: sha256.nullable(),
            coverageValidationArtifactHash: sha256.nullable(),
          })
          .strict()
      )
      .min(1)
      .max(100),
    cases: z.array(goldCaseSchema).max(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const panelKeys = new Set(value.panelVersions.map(panel => panel.key));
    if (panelKeys.size !== value.panelVersions.length) {
      ctx.addIssue({
        code: "custom",
        path: ["panelVersions"],
        message: "Panel version keys must be unique.",
      });
    }

    const caseIds = new Set<string>();
    value.cases.forEach((clinicalCase, caseIndex) => {
      if (caseIds.has(clinicalCase.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", caseIndex, "id"],
          message: "Case identifiers must be unique.",
        });
      }
      caseIds.add(clinicalCase.id);
      if (!panelKeys.has(clinicalCase.panelVersionKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", caseIndex, "panelVersionKey"],
          message: "Case panelVersionKey must reference panelVersions.",
        });
      }
      if (
        value.status === "final" &&
        clinicalCase.variants.some(variant => variant.reviewStatus === "draft")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", caseIndex, "variants"],
          message: "Final packs cannot contain draft expert reviews.",
        });
      }
    });

    if (value.status === "final" && value.cases.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["cases"],
        message: "A final expert gold pack must contain at least one case.",
      });
    }
  });

export type SomaticExpertGoldPack = z.infer<typeof somaticExpertGoldSchema>;

export async function loadSomaticExpertGoldPack(
  path: string
): Promise<SomaticExpertGoldPack> {
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  return somaticExpertGoldSchema.parse(input);
}


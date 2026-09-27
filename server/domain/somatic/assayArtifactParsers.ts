import { z } from "zod";
import { SomaticArtifactParseError } from "./artifactParsers";

const result = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CNV"),
    gene: z.string().trim().min(1).max(80),
    copyNumber: z.number().nonnegative().optional(),
    log2Ratio: z.number().optional(),
    call: z.enum(["amplification", "gain", "loss", "deletion"]),
  }),
  z.object({
    type: z.literal("FUSION"),
    fivePrimeGene: z.string().trim().min(1).max(80),
    threePrimeGene: z.string().trim().min(1).max(80),
    inFrame: z.boolean().optional(),
    supportingReads: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("MSI"),
    score: z.number().optional(),
    category: z.enum(["stable", "low", "high", "indeterminate"]),
  }),
  z.object({
    type: z.literal("TMB"),
    mutationsPerMb: z.number().nonnegative(),
    category: z.enum(["low", "intermediate", "high"]).optional(),
  }),
  z.object({
    type: z.literal("HRD"),
    score: z.number().optional(),
    category: z.enum(["negative", "positive", "indeterminate"]),
    method: z.string().trim().min(1).max(200),
  }),
]);

const record = z
  .object({
    findingType: z.enum(["CNV", "FUSION", "MSI", "TMB", "HRD"]),
    status: z.enum([
      "detected",
      "not_detected",
      "not_tested",
      "indeterminate",
    ]),
    result: result.nullable(),
    sourceRunId: z.string().trim().min(1).max(160).nullable(),
    coverageSummaryId: z.number().int().positive().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.result && value.result.type !== value.findingType) {
      ctx.addIssue({
        code: "custom",
        path: ["result", "type"],
        message: "Result type must match findingType.",
      });
    }
    if (value.status === "detected" && !value.result) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "Detected findings require a typed result.",
      });
    }
  });

export type ParsedAssayFinding = z.infer<typeof record>;

export function parseAssayArtifact(text: string): ParsedAssayFinding[] {
  if (!text.trim()) throw new SomaticArtifactParseError("Artifact is empty.");
  if (Buffer.byteLength(text, "utf8") > 20_000_000) {
    throw new SomaticArtifactParseError("Artifact exceeds 20000000 bytes.");
  }
  let raw: unknown[];
  if (text.trimStart().startsWith("[")) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (!Array.isArray(decoded)) throw new Error();
      raw = decoded;
    } catch {
      throw new SomaticArtifactParseError(
        "Assay JSON must be a valid array."
      );
    }
  } else {
    const lines = text
      .split(/\r?\n/)
      .filter(line => line.trim() && !line.trim().startsWith("#"));
    const expected = [
      "findingType",
      "status",
      "result",
      "sourceRunId",
      "coverageSummaryId",
    ];
    if (lines[0]?.split("\t").join("\t") !== expected.join("\t")) {
      throw new SomaticArtifactParseError(
        `Assay TSV header must be ${expected.join(", ")}.`
      );
    }
    raw = lines.slice(1).map((line, index) => {
      const columns = line.split("\t");
      if (columns.length !== 5) {
        throw new SomaticArtifactParseError(
          "Assay TSV records require exactly five columns.",
          index + 2
        );
      }
      let parsedResult: unknown = null;
      if (columns[2]) {
        try {
          parsedResult = JSON.parse(columns[2]);
        } catch {
          throw new SomaticArtifactParseError(
            "result must be JSON or empty.",
            index + 2
          );
        }
      }
      return {
        findingType: columns[0],
        status: columns[1],
        result: parsedResult,
        sourceRunId: columns[3] || null,
        coverageSummaryId: columns[4] ? Number(columns[4]) : null,
      };
    });
  }
  if (!raw.length) {
    throw new SomaticArtifactParseError("Assay artifact has no records.");
  }
  if (raw.length > 1_000) {
    throw new SomaticArtifactParseError("Assay artifact exceeds 1000 records.");
  }
  return raw.map((value, index) => {
    const parsed = record.safeParse(value);
    if (!parsed.success) {
      throw new SomaticArtifactParseError(
        parsed.error.issues[0]?.message || "Invalid assay finding.",
        index + 2
      );
    }
    return parsed.data;
  });
}

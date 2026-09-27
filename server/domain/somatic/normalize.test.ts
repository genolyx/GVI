import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Variant } from "../../../drizzle/schema";
import { analyzeSomaticVariant } from "./normalize";

function variant(overrides: Partial<Variant> = {}): Variant {
  const now = new Date();
  return {
    id: 1,
    organizationId: 1,
    caseId: 1,
    normalizedId: "GRCh38:7:55259515:T:G",
    referenceBuild: "GRCh38",
    chromosome: "7",
    position: 55259515,
    referenceAllele: "T",
    alternateAllele: "G",
    gene: "EGFR",
    transcript: "NM_005228.5",
    hgvsC: "c.2573T>G",
    hgvsP: "p.Leu858Arg",
    consequence: "missense_variant",
    variantType: "SNV",
    zygosity: null,
    populationAf: null,
    vaf: "0.31",
    readDepth: 420,
    alternateDepth: 130,
    impact: "MODERATE",
    clinvarSignificance: null,
    reviewStatus: "unreviewed",
    annotation: { callFilter: "PASS" },
    triageTier: null,
    triageScore: null,
    triageReasons: null,
    triagedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixtureVariants() {
  const path = fileURLToPath(
    new URL("../../../shared/fixtures/somatic/v1/cases.vcf", import.meta.url)
  );
  const rows = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"));

  return Object.fromEntries(
    rows.map((line, index) => {
      const [chromosome, position, id, reference, alternate, , filter, info] =
        line.split("\t");
      const fields = Object.fromEntries(
        info.split(";").map(item => item.split("=", 2))
      );
      return [
        id,
        variant({
          id: index + 1,
          normalizedId: `${fields.BUILD}:${chromosome}:${position}:${reference}:${alternate}`,
          referenceBuild: fields.BUILD as Variant["referenceBuild"],
          chromosome,
          position: Number(position),
          referenceAllele: reference,
          alternateAllele: alternate,
          gene: fields.GENE,
          variantType:
            reference.length === 1 && alternate.length === 1 ? "SNV" : "INDEL",
          vaf: fields.VAF,
          readDepth: Number(fields.DP),
          impact: fields.IMPACT as Variant["impact"],
          annotation: { callFilter: filter },
        }),
      ];
    })
  ) as Record<string, Variant>;
}

describe("somatic variant analysis", () => {
  it("accepts a target-panel SNV with adequate QC", () => {
    const result = analyzeSomaticVariant(variant());
    expect(result.normalizationStatus).toBe("normalized");
    expect(result.qcStatus).toBe("pass");
    expect(result.candidate).toBe(true);
  });

  it("fails closed when the submitted build differs from the panel build", () => {
    const result = analyzeSomaticVariant(variant(), "GRCh37");

    expect(result).toMatchObject({
      normalizationStatus: "failed",
      normalizationError:
        "Variant build GRCh38 does not match panel build GRCh37.",
      normalizedRepresentation: null,
      transcriptPolicy: null,
      qcStatus: "manual_review_required",
      qcReasons: ["panel_build_mismatch"],
      candidate: false,
    });
    expect(result.originalRepresentation).toMatchObject({
      build: "GRCh38",
      chromosome: "7",
      position: 55259515,
      reference: "T",
      alternate: "G",
    });
  });

  it("normalizes normally when the submitted and panel builds agree", () => {
    const result = analyzeSomaticVariant(
      variant({ chromosome: "chr7", referenceAllele: "t" }),
      "GRCh38"
    );

    expect(result.normalizationStatus).toBe("normalized");
    expect(result.normalizedRepresentation).toMatchObject({
      build: "GRCh38",
      chromosome: "7",
      reference: "T",
      alternate: "G",
    });
    expect(result.qcReasons).not.toContain("panel_build_mismatch");
  });

  it("does not promote low-depth or low-VAF calls", () => {
    const result = analyzeSomaticVariant(
      variant({ readDepth: 12, vaf: "0.01" })
    );
    expect(result.candidate).toBe(false);
    expect(result.qcReasons).toContain("depth_below_20");
    expect(result.qcReasons).toContain("vaf_below_0.02");
  });

  it("holds unsupported complex alterations outside Phase 1", () => {
    const result = analyzeSomaticVariant(variant({ variantType: "FUSION" }));
    expect(result.normalizationStatus).toBe("failed");
    expect(result.qcStatus).toBe("manual_review_required");
    expect(result.candidate).toBe(false);
  });

  it("does not claim repeat-aware left alignment without a reference FASTA", () => {
    const result = analyzeSomaticVariant(
      variant({
        variantType: "INDEL",
        referenceAllele: "AT",
        alternateAllele: "A",
      })
    );
    expect(result.normalizationStatus).toBe("normalized");
    expect(result.qcStatus).toBe("manual_review_required");
    expect(result.qcReasons).toContain(
      "reference_fasta_left_alignment_not_verified"
    );
  });

  it("matches the fixture pack normalization and QC matrix", async () => {
    const fixtures = await fixtureVariants();
    const expected = {
      "egfr-l858r-sensitivity": ["pass", true, []],
      "braf-v600e": ["pass", true, []],
      "prognostic-only": ["pass", true, []],
      "other-tumor-unknown": ["pass", true, []],
      conflict: ["pass", true, []],
      "no-evidence": ["pass", true, []],
      "low-vaf": ["low_vaf", false, ["vaf_below_0.02"]],
      "low-depth": ["low_depth", false, ["depth_below_20"]],
      "build-mismatch": [
        "manual_review_required",
        false,
        ["panel_build_mismatch"],
      ],
      "indel-manual-review": [
        "manual_review_required",
        false,
        ["reference_fasta_left_alignment_not_verified"],
      ],
      "provider-outage": ["pass", true, []],
    } as const;

    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, [qcStatus, candidate, reasons]] of Object.entries(
      expected
    )) {
      const result = analyzeSomaticVariant(fixtures[id], "GRCh38");
      expect(
        {
          normalizationStatus: result.normalizationStatus,
          qcStatus: result.qcStatus,
          candidate: result.candidate,
          qcReasons: result.qcReasons,
        },
        id
      ).toEqual({
        normalizationStatus: id === "build-mismatch" ? "failed" : "normalized",
        qcStatus,
        candidate,
        qcReasons: [...reasons],
      });
    }
  });
});

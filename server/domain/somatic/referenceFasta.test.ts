import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Variant } from "../../../drizzle/schema";
import { analyzeSomaticVariant } from "./normalize";
import { normalizeIndelWithReference } from "./referenceFasta";

function variant(overrides: Partial<Variant> = {}): Variant {
  const now = new Date();
  return {
    id: 1,
    organizationId: 1,
    caseId: 1,
    normalizedId: "GRCh38:1:7:TT:T",
    referenceBuild: "GRCh38",
    chromosome: "chr1",
    position: 7,
    referenceAllele: "TT",
    alternateAllele: "T",
    gene: "TEST",
    transcript: null,
    hgvsC: null,
    hgvsP: null,
    consequence: "frameshift_variant",
    variantType: "INDEL",
    zygosity: null,
    populationAf: null,
    vaf: "0.2",
    readDepth: 100,
    alternateDepth: 20,
    impact: "HIGH",
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

async function reference() {
  const directory = await mkdtemp(join(tmpdir(), "gvi-fasta-"));
  const fastaPath = join(directory, "GRCh38.fa");
  const fasta = ">chr1\nAACCTTTTTGG\n";
  // Header is 6 bytes. The sequence is one 11-base line plus newline.
  await writeFile(fastaPath, fasta);
  await writeFile(`${fastaPath}.fai`, "chr1\t11\t6\t11\t12\n");
  return {
    build: "GRCh38" as const,
    fastaPath,
    expectedSha256: createHash("sha256").update(fasta).digest("hex"),
    version: "test-reference-1",
  };
}

describe("reference FASTA somatic normalization", () => {
  it("left-aligns a deletion through a homopolymer and records provenance", async () => {
    const normalized = await normalizeIndelWithReference(
      variant(),
      await reference()
    );
    expect(normalized).toMatchObject({
      chromosome: "1",
      position: 4,
      reference: "CT",
      alternate: "C",
      normalizedId: "GRCh38:1:4:CT:C",
      shiftedBases: 3,
      referenceProvenance: {
        fastaVersion: "test-reference-1",
        fastaSha256: createHash("sha256")
          .update(">chr1\nAACCTTTTTGG\n")
          .digest("hex"),
      },
    });

    const analysis = analyzeSomaticVariant(variant(), "GRCh38", normalized);
    expect(analysis).toMatchObject({
      normalizationStatus: "normalized",
      qcStatus: "pass",
      candidate: true,
      normalizedRepresentation: {
        normalizedId: "GRCh38:1:4:CT:C",
        position: 4,
      },
    });
    expect(analysis.qcReasons).not.toContain(
      "reference_fasta_left_alignment_not_verified"
    );
  });

  it("rejects a submitted REF that disagrees with the pinned FASTA", async () => {
    await expect(
      normalizeIndelWithReference(
        variant({ referenceAllele: "TA" }),
        await reference()
      )
    ).rejects.toThrow(/Submitted REF does not match GRCh38 FASTA/);
  });

  it("retains fail-closed manual review when no reference is configured", async () => {
    const normalized = await normalizeIndelWithReference(variant(), null);
    expect(normalized).toBeNull();
    const analysis = analyzeSomaticVariant(variant(), "GRCh38", normalized);
    expect(analysis.qcStatus).toBe("manual_review_required");
    expect(analysis.candidate).toBe(false);
  });
});

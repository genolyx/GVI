import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Variant } from "../../../drizzle/schema";
import { createFixtureSomaticEvidenceProvider } from "./fixtureProvider";
import {
  evaluateSomaticProposal,
  parseApprovedGuidelineRule,
} from "./rules";

type Evidence = Parameters<typeof evaluateSomaticProposal>[0][number];

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    clinicalDomain: "therapeutic",
    direction: "supporting",
    diseaseMatch: "exact",
    sourceNativeLevel: "A",
    ...overrides,
  };
}

function fixtureVariant(normalizedId: string): Variant {
  const [, build, chromosome, position, reference, alternate] =
    normalizedId.match(/^(GRCh3[78]):([^:]+):(\d+):([^:]+):([^:]+)$/) ?? [];
  const now = new Date(0);
  return {
    id: 1,
    organizationId: 1,
    caseId: 1,
    normalizedId,
    referenceBuild: build as Variant["referenceBuild"],
    chromosome,
    position: Number(position),
    referenceAllele: reference,
    alternateAllele: alternate,
    gene: null,
    transcript: null,
    hgvsC: null,
    hgvsP: null,
    consequence: null,
    variantType: "SNV",
    zygosity: null,
    populationAf: null,
    vaf: "0.3",
    readDepth: 200,
    alternateDepth: 60,
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
  };
}

describe("conservative somatic rules evaluator", () => {
  it("never maps a source-native level to an AMP tier or level", () => {
    for (const sourceNativeLevel of ["A", "LEVEL_1", "FDA-approved"]) {
      const result = evaluateSomaticProposal([evidence({ sourceNativeLevel })]);

      expect(result.systemTier).toBeNull();
      expect(result.systemLevel).toBeNull();
      expect(result.reasonCodes).toEqual(["approved_guideline_rule_missing"]);
      expect(result.rationale).toContain(
        "no approved guideline rule establishes an AMP Tier/Level"
      );
    }
  });

  it("applies one approved disease-pinned guideline rule without copying the provider level", () => {
    const rule = parseApprovedGuidelineRule(
      {
        schemaVersion: 1,
        kind: "somatic_amp_proposal_rule",
        gene: "EGFR",
        normalizedVariantId: "GRCh38:7:55259515:T:G",
        clinicalDomain: "therapeutic",
        tumor: {
          ontologySystem: "OncoTree",
          ontologyVersion: "2026-09",
          code: "LUAD",
        },
        requiredDirection: "supporting",
        systemTier: "Tier I",
        systemLevel: "A",
      },
      {
        recordId: 4,
        recordKey: "EGFR-L858R-LUAD",
        releaseId: 2,
        releaseVersion: "2026.09",
        providerCode: "INSTITUTIONAL_AMP",
        sourceCitation: "Institutional SOP 3.1.2",
      }
    );
    expect(rule).not.toBeNull();

    const result = evaluateSomaticProposal(
      [evidence({ sourceNativeLevel: "provider-level-not-A" })],
      {
        variant: {
          gene: "EGFR",
          normalizedId: "GRCh38:7:55259515:T:G",
        },
        tumor: {
          ontologySystem: "OncoTree",
          ontologyVersion: "2026-09",
          code: "LUAD",
        },
        guidelineRules: [rule!],
      }
    );

    expect(result).toMatchObject({
      systemTier: "Tier I",
      systemLevel: "A",
      conflict: false,
      reasonCodes: ["approved_guideline_rule_applied"],
      appliedRule: {
        recordKey: "EGFR-L858R-LUAD",
        releaseVersion: "2026.09",
      },
    });
    expect(result.rationale).toContain(
      "Source-native evidence levels were not converted"
    );
  });

  it("fails closed when multiple approved rules match", () => {
    const provenance = {
      recordId: 1,
      recordKey: "rule-1",
      releaseId: 2,
      releaseVersion: "2026.09",
      providerCode: "INSTITUTIONAL_AMP",
      sourceCitation: "Institutional SOP 3.1.2",
    };
    const definition = {
      schemaVersion: 1 as const,
      kind: "somatic_amp_proposal_rule" as const,
      gene: "EGFR",
      normalizedVariantId: null,
      clinicalDomain: "therapeutic" as const,
      tumor: {
        ontologySystem: "OncoTree",
        ontologyVersion: "2026-09",
        code: "LUAD",
      },
      requiredDirection: "supporting" as const,
      systemTier: "Tier I" as const,
      systemLevel: "A" as const,
    };
    const first = parseApprovedGuidelineRule(definition, provenance)!;
    const second = parseApprovedGuidelineRule(definition, {
      ...provenance,
      recordId: 2,
      recordKey: "rule-2",
    })!;

    const result = evaluateSomaticProposal([evidence()], {
      variant: { gene: "EGFR", normalizedId: "GRCh38:7:1:A:T" },
      tumor: {
        ontologySystem: "OncoTree",
        ontologyVersion: "2026-09",
        code: "LUAD",
      },
      guidelineRules: [first, second],
    });

    expect(result.systemTier).toBeNull();
    expect(result.systemLevel).toBeNull();
    expect(result.reasonCodes).toEqual([
      "multiple_guideline_rules_matched",
      "approved_guideline_rule_missing",
    ]);
  });

  it("flags conflicting evidence directions without assigning AMP values", () => {
    const result = evaluateSomaticProposal([
      evidence({ direction: "supporting" }),
      evidence({
        direction: "contradicting",
        sourceNativeLevel: "B",
      }),
    ]);

    expect(result).toMatchObject({
      systemTier: null,
      systemLevel: null,
      conflict: true,
      reasonCodes: ["direction_conflict", "approved_guideline_rule_missing"],
    });
    expect(result.rationale).toContain("conflicting directions");
  });

  it("requires expert review for unknown disease matching", () => {
    const result = evaluateSomaticProposal([
      evidence({ diseaseMatch: "unknown", sourceNativeLevel: "LEVEL_1" }),
    ]);

    expect(result).toMatchObject({
      systemTier: null,
      systemLevel: null,
      conflict: false,
      reasonCodes: [
        "disease_match_requires_review",
        "approved_guideline_rule_missing",
      ],
    });
    expect(result.rationale).toContain(
      "disease matching requires expert review"
    );
    expect(result.rationale).toContain("No provider level was copied into AMP");
  });

  it("matches the fixture pack reason-code matrix without AMP mixing", async () => {
    const path = fileURLToPath(
      new URL(
        "../../../shared/fixtures/somatic/v1/manifest.json",
        import.meta.url
      )
    );
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      cases: Array<{
        id: string;
        variantId: string;
        tumorLabel: string;
      }>;
    };
    const expected: Record<string, string[]> = {
      "egfr-l858r-sensitivity": ["approved_guideline_rule_missing"],
      "braf-v600e": ["approved_guideline_rule_missing"],
      "prognostic-only": ["approved_guideline_rule_missing"],
      "other-tumor-unknown": [
        "disease_match_requires_review",
        "approved_guideline_rule_missing",
      ],
      conflict: ["direction_conflict", "approved_guideline_rule_missing"],
      "no-evidence": ["no_accepted_evidence"],
      "low-vaf": ["no_accepted_evidence"],
      "low-depth": ["no_accepted_evidence"],
      "build-mismatch": ["no_accepted_evidence"],
      "indel-manual-review": ["no_accepted_evidence"],
      "provider-outage": ["no_accepted_evidence"],
    };
    const provider = createFixtureSomaticEvidenceProvider();

    expect(manifest.cases.map(item => item.id).sort()).toEqual(
      Object.keys(expected).sort()
    );
    for (const fixtureCase of manifest.cases) {
      const collected = await provider.collect(
        fixtureVariant(fixtureCase.variantId),
        fixtureCase.tumorLabel
      );
      const result = evaluateSomaticProposal(collected.records);

      expect(result.reasonCodes, fixtureCase.id).toEqual(
        expected[fixtureCase.id]
      );
      expect(result.systemTier, fixtureCase.id).toBeNull();
      expect(result.systemLevel, fixtureCase.id).toBeNull();
    }
  });
});

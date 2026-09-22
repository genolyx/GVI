import { describe, expect, it } from "vitest";
import { _somaticKbTest, factsFromSomaticDrafts } from "./somaticKb";

describe("CIViC GraphQL → evidence drafts", () => {
  it("keeps accepted evidence for the matching protein change", () => {
    const drafts = _somaticKbTest.civicDraftsFromGene("BRAF", "V600E", "melanoma", {
      data: {
        genes: {
          nodes: [
            {
              name: "BRAF",
              variants: {
                nodes: [
                  {
                    name: "V600E",
                    singleVariantMolecularProfile: {
                      evidenceItems: {
                        nodes: [
                          {
                            id: 12,
                            status: "ACCEPTED",
                            evidenceType: "Predictive",
                            evidenceLevel: "A",
                            evidenceDirection: "Supports",
                            significance: "Sensitivity/Response",
                            disease: { name: "Melanoma" },
                            therapies: [{ name: "vemurafenib" }],
                          },
                          {
                            id: 99,
                            status: "SUBMITTED",
                            evidenceType: "Predictive",
                            evidenceLevel: "A",
                          },
                        ],
                      },
                    },
                  },
                  {
                    name: "V600K",
                    singleVariantMolecularProfile: {
                      evidenceItems: { nodes: [{ id: 7, status: "ACCEPTED", evidenceLevel: "B" }] },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceRecordId).toBe("12");
    expect(drafts[0].clinicalDomain).toBe("therapeutic");
    expect(drafts[0].payload.ampLevel).toBe("A");
    expect(drafts[0].payload.sameTumor).toBe(true);
  });

  it("reads the live gene(entrezSymbol) payload shape", () => {
    const drafts = _somaticKbTest.civicDraftsFromGene("BRAF", "V600E", "Melanoma", {
      data: {
        gene: {
          name: "BRAF",
          variants: {
            nodes: [
              {
                name: "V600E",
                singleVariantMolecularProfile: {
                  evidenceItems: {
                    nodes: [
                      {
                        id: 95,
                        status: "ACCEPTED",
                        evidenceType: "PREDICTIVE",
                        evidenceLevel: "B",
                        evidenceDirection: "SUPPORTS",
                        significance: "SENSITIVITYRESPONSE",
                        disease: { name: "Melanoma" },
                        therapies: [{ name: "Dabrafenib" }],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload.ampLevel).toBe("B");
    expect(drafts[0].clinicalDomain).toBe("therapeutic");
  });
});

describe("OncoKB annotation → evidence drafts", () => {
  it("emits oncogenicity plus the highest therapeutic level", () => {
    const drafts = _somaticKbTest.oncokbDrafts(
      {
        gene: "BRAF",
        hgvsP: "p.Val600Glu",
      } as any,
      "V600E",
      "Melanoma",
      {
        query: { hugoSymbol: "BRAF", alteration: "V600E", tumorType: "Melanoma" },
        oncogenic: "Oncogenic",
        mutationEffect: { knownEffect: "Gain-of-function" },
        highestSensitiveLevel: "LEVEL_1",
        hotspot: true,
        treatments: [{ level: "LEVEL_1", drugs: [{ drugName: "vemurafenib" }] }],
      }
    );
    expect(drafts.some(d => d.clinicalDomain === "oncogenicity")).toBe(true);
    expect(drafts.some(d => d.evidenceLevel === "LEVEL_1" && d.payload.ampLevel === "A")).toBe(true);
    const facts = factsFromSomaticDrafts(drafts);
    expect(facts.some(f => f.oncogenicLabel === "Oncogenic")).toBe(true);
  });
});

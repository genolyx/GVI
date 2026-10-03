import { describe, expect, it } from "vitest";
import { GENE_SCOPE_REQUIRED } from "../../shared/geneScope";
import { resolveGermlineScope } from "./geneScope";

describe("germline gene scope", () => {
  it("rejects a germline run with no panel and no HPO terms", async () => {
    await expect(
      resolveGermlineScope({
        purpose: "germline",
        panel: null,
        filters: {
          hpo: "",
          genes: "",
          maxAf: 0.001,
          minQual: null,
          minGenotypeQuality: null,
          minDepth: null,
          passOnly: true,
          codingOnly: false,
          excludeClinvarBenign: false,
          excludeClinvarVus: false,
        },
        phenotypeText: "",
      })
    ).rejects.toThrow(GENE_SCOPE_REQUIRED);
  });

  it("keeps a carrier panel run that has no HPO terms", async () => {
    const filters = {
      hpo: "",
      genes: "",
      maxAf: 0.001,
      minQual: null,
      minGenotypeQuality: null,
      minDepth: null,
      passOnly: true,
      codingOnly: false,
      excludeClinvarBenign: false,
      excludeClinvarVus: false,
    };
    await expect(
      resolveGermlineScope({
        purpose: "germline",
        panel: { genes: ["PAH", "CFTR"], regions: null },
        filters,
        phenotypeText: "",
      })
    ).resolves.toBe(filters);
  });
});

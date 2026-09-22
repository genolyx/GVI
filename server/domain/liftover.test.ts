import { describe, expect, it, vi } from "vitest";
import { ensemblMapUrl, parseEnsemblMap, resolveEngineBuild } from "./liftover";

const BRCA1_PAYLOAD = {
  mappings: [
    {
      original: { seq_region_name: "17", start: 41196312, end: 41196312, strand: 1 },
      mapped: { seq_region_name: "17", start: 43044257, end: 43044257, strand: 1 },
    },
  ],
};

describe("GRCh37 → GRCh38 liftover", () => {
  it("builds the Ensembl assembly-map URL without a chr prefix", () => {
    expect(ensemblMapUrl("chr17", 41196312)).toBe(
      "https://rest.ensembl.org/map/human/GRCh37/17:41196312..41196312/GRCh38?content-type=application/json"
    );
  });

  it("reads the mapped GRCh38 locus from an Ensembl payload", () => {
    const result = parseEnsemblMap(BRCA1_PAYLOAD, { chromosome: "17", position: 41196312 });
    expect(result).toEqual({
      ok: true,
      locus: {
        chromosome: "17",
        position: 43044257,
        source: "ensembl_map",
        from: { build: "GRCh37", chromosome: "17", position: 41196312 },
      },
    });
  });

  it("rejects an empty mapping rather than inventing a coordinate", () => {
    expect(parseEnsemblMap({ mappings: [] }, { chromosome: "1", position: 100 }).ok).toBe(false);
    expect(parseEnsemblMap({}, { chromosome: "1", position: 100 }).ok).toBe(false);
  });

  it("leaves a GRCh38 variant untouched", async () => {
    const resolved = await resolveEngineBuild({
      referenceBuild: "GRCh38",
      chromosome: "17",
      position: 43044257,
    });
    expect(resolved).toEqual({
      referenceBuild: "GRCh38",
      submittedBuild: "GRCh38",
      liftedLocus: null,
      liftError: null,
    });
  });

  it("records a successful lift on a GRCh37 variant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => BRCA1_PAYLOAD,
    });
    const { liftGrch37To38 } = await import("./liftover");
    const result = await liftGrch37To38("17", 41196312, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.locus.position).toBe(43044257);
  });
});

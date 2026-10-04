import { describe, expect, it } from "vitest";
import { frequencyTrackForOrder } from "./germlineFrequency";
import {
  GERMLINE_FILTER_CONTRACT_VERSION,
  interpretPartnerJob,
  PARTNER_CLASSIFICATION_RULESET,
  resolvePartnerTrack,
} from "./partnerInterpretation";

const sha = "a".repeat(64);

function request(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "1",
    externalOrderId: "CSGX26070001",
    serviceCode: "carrier_screening",
    referenceBuild: "GRCh38",
    vcf: { sha256: sha, uri: "file:///orders/CSGX26070001/annotated.vcf.gz" },
    genes: "CFTR, PAH",
    ...overrides,
  };
}

describe("portal service to GVC track", () => {
  it("maps carrier screening to the carrier track and defers dark genes", () => {
    expect(resolvePartnerTrack({ serviceCode: "carrier_screening" })).toEqual({
      accepted: true,
      track: "carrier",
      canonicalService: "carrier_screening",
      darkGeneResult: "deferred",
    });
    expect(resolvePartnerTrack({ serviceCode: "carrier" })).toMatchObject({
      track: "carrier",
    });
    expect(
      resolvePartnerTrack({ serviceCode: "carrier_couples" })
    ).toMatchObject({ track: "carrier" });
  });

  it("maps whole exome to rare disease", () => {
    expect(resolvePartnerTrack({ serviceCode: "whole_exome" })).toMatchObject({
      accepted: true,
      track: "rare_disease",
      canonicalService: "whole_exome",
      darkGeneResult: "not_requested",
    });
    expect(resolvePartnerTrack({ serviceCode: "wes_panel" })).toMatchObject({
      track: "rare_disease",
    });
  });

  it("lets a carrier panel on a whole-exome order use the carrier track", () => {
    expect(
      resolvePartnerTrack({
        serviceCode: "whole_exome",
        panelCategory: "carrier_screening",
      })
    ).toMatchObject({ track: "carrier", darkGeneResult: "deferred" });
  });

  it("maps a hereditary cancer panel onto its own track", () => {
    expect(
      resolvePartnerTrack({
        serviceCode: "whole_exome",
        packageCode: "HereditaryCancer",
      })
    ).toMatchObject({
      track: "hereditary_cancer",
      darkGeneResult: "not_requested",
    });
    expect(
      resolvePartnerTrack({
        serviceCode: "carrier_screening",
        panelCategory: "hereditary_cancer",
      })
    ).toMatchObject({
      track: "hereditary_cancer",
      canonicalService: "carrier_screening",
    });
  });

  it("maps health screening onto the carrier frequency rules without dark genes", () => {
    expect(resolvePartnerTrack({ serviceCode: "health_screening" })).toEqual({
      accepted: true,
      track: "carrier",
      canonicalService: "health_screening",
      darkGeneResult: "not_requested",
    });
    expect(resolvePartnerTrack({ serviceCode: "health_snp" })).toMatchObject({
      track: "carrier",
      canonicalService: "health_screening",
      darkGeneResult: "not_requested",
    });
    expect(
      resolvePartnerTrack({
        serviceCode: "whole_exome",
        panelCategory: "proactive_health",
      })
    ).toMatchObject({ canonicalService: "health_screening", darkGeneResult: "not_requested" });
    expect(
      resolvePartnerTrack({
        serviceCode: "carrier_screening",
        packageCode: "HealthScreening",
      })
    ).toMatchObject({ canonicalService: "health_screening" });
    expect(resolvePartnerTrack({ serviceCode: "sgnipt" }).reason).toBe(
      "sgnipt_out_of_scope"
    );
    expect(
      resolvePartnerTrack({
        serviceCode: "carrier_screening",
        panelCategory: "pgx",
      }).reason
    ).toBe("pgx_only_out_of_scope");
  });

  it("leaves standalone GVC health-screening orders on the existing carrier fallback", () => {
    expect(
      frequencyTrackForOrder({
        testCategory: "standard_carrier",
        packageCode: "HealthScreening",
      })
    ).toBe("carrier");
  });
});

describe("partner interpretation job", () => {
  it("accepts a scoped carrier job and builds a stable idempotency key", () => {
    const result = interpretPartnerJob(
      request({ vcf: { sha256: sha.toUpperCase(), uri: "file:///a.vcf.gz" } })
    );
    expect(result).toMatchObject({
      accepted: true,
      track: "carrier",
      filterContractVersion: GERMLINE_FILTER_CONTRACT_VERSION,
      rulesetVersion: PARTNER_CLASSIFICATION_RULESET,
      idempotencyKey: `CSGX26070001:${sha}:${GERMLINE_FILTER_CONTRACT_VERSION}:${PARTNER_CLASSIFICATION_RULESET}`,
    });
    if (result.accepted) expect(result.request.vcf.sha256).toBe(sha);
  });

  it("keeps a panel code in the idempotency key", () => {
    const result = interpretPartnerJob(
      request({
        serviceCode: "whole_exome",
        wesPanelId: "full_wes",
        panelCode: "carrier-2000",
        genes: "CFTR,PAH",
      })
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.idempotencyKey.endsWith(":carrier-2000")).toBe(true);
      expect(result.request.panelCode).toBe("carrier-2000");
    }
  });

  it("uses a portal frequency track instead of the service mapping", () => {
    const result = interpretPartnerJob(
      request({
        serviceCode: "whole_exome",
        wesPanelId: "full_wes",
        panelCode: "carrier-2000",
        genes: "",
        hpo: "",
        frequencyTrack: "carrier",
      })
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.track).toBe("carrier");
      expect(result.canonicalService).toBe("whole_exome");
      expect(result.idempotencyKey.endsWith(":carrier-2000:carrier")).toBe(true);
    }
  });

  it("keeps a read-depth limit in the idempotency key", () => {
    const result = interpretPartnerJob(
      request({
        minQual: 30,
        minGenotypeQuality: 20,
        minDepth: 20,
        passOnly: false,
      })
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.minDepth).toBe(20);
      expect(result.idempotencyKey.endsWith(":qual=30:gq=20:dp=20:pass=any")).toBe(true);
    }
  });

  it("accepts a whole-exome vcf-only order without a gene list", () => {
    expect(
      interpretPartnerJob(
        request({
          serviceCode: "whole_exome",
          wesPanelId: "full_wes",
          genes: "",
          hpo: "",
        })
      )
    ).toMatchObject({
      accepted: true,
      track: "rare_disease",
      canonicalService: "whole_exome",
      darkGeneResult: "not_requested",
    });
  });

  it("requires a gene list or HPO terms before accepting", () => {
    expect(interpretPartnerJob(request({ genes: " ", hpo: "" }))).toMatchObject(
      {
        accepted: false,
        reason: "gene_scope_required",
      }
    );
    expect(
      interpretPartnerJob(request({ genes: "", hpo: "HP:0001250" }))
    ).toMatchObject({
      accepted: true,
      track: "carrier",
    });
  });

  it("rejects a caller track that disagrees with the mapping", () => {
    expect(
      interpretPartnerJob(request({ expectedTrack: "rare_disease" }))
    ).toMatchObject({
      accepted: false,
      reason: "track_mismatch",
    });
  });

  it("rejects BAM and other fields that belong to the portal", () => {
    expect(
      interpretPartnerJob(request({ bamUri: "file:///sample.bam" }))
    ).toMatchObject({
      accepted: false,
      reason: "invalid_request",
    });
  });

  it("does not accept an out-of-scope service even when genes are present", () => {
    expect(
      interpretPartnerJob(request({ serviceCode: "sgnipt" }))
    ).toMatchObject({
      accepted: false,
      reason: "sgnipt_out_of_scope",
    });
  });
});

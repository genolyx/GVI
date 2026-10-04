import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ALLELE_FREQUENCY } from "@shared/germlineFrequency";
import { partnerInterpretationIdempotencyKey } from "@shared/partnerInterpretation";
import {
  partnerJobLookupId,
  partnerJobStorageKey,
  partnerSkipsGeneScope,
  partnerStatusFromParts,
  partnerVcfFilters,
  samePartnerOrderAction,
  type PartnerJobManifest,
} from "./partnerJobState";

describe("partner job state", () => {
  it("stores a short id for the long idempotency key and accepts either on lookup", () => {
    const key = partnerInterpretationIdempotencyKey({
      externalOrderId: "CSGX26070001",
      vcfSha256: "ab".repeat(32),
    });
    const id = partnerJobStorageKey(key);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id.length).toBeLessThanOrEqual(80);
    expect(partnerJobLookupId(id)).toBe(id);
    expect(partnerJobLookupId(key)).toBe(id);
  });

  it("reuses one case when the same order arrives with a new panel", () => {
    expect(
      samePartnerOrderAction({
        storedIdempotencyKey: "order:sha:1:1.0",
        incomingIdempotencyKey: "order:sha:1:1.0:carrier-2000:carrier",
        jobStatus: "review_ready",
        caseStatus: "review_ready",
      })
    ).toBe("replace");
    expect(
      samePartnerOrderAction({
        storedIdempotencyKey: "order:sha:1:1.0:carrier-2000:carrier",
        incomingIdempotencyKey: "order:sha:1:1.0:carrier-2000:carrier",
        jobStatus: "failed",
        caseStatus: "failed",
      })
    ).toBe("reopen");
    expect(
      samePartnerOrderAction({
        storedIdempotencyKey: "order:sha:1:1.0",
        incomingIdempotencyKey: "order:sha:1:1.0:carrier-2000",
        jobStatus: "review_ready",
        caseStatus: "reported",
      })
    ).toBe("keep");
  });

  it("uses the carrier frequency limit when the request omits maxAf", () => {
    expect(
      partnerVcfFilters({
        genes: "CFTR",
        hpo: "",
        maxAf: null,
        track: "carrier",
      })
    ).toMatchObject({
      maxAf: DEFAULT_MAX_ALLELE_FREQUENCY,
      passOnly: true,
      track: "carrier",
      genes: "CFTR",
    });
  });

  it("applies the quality limits from the portal order", () => {
    expect(
      partnerVcfFilters({
        genes: "CFTR",
        hpo: "",
        maxAf: 0.001,
        track: "carrier",
        minQual: 30,
        minGenotypeQuality: 20,
        minDepth: 20,
        passOnly: false,
      })
    ).toMatchObject({
      minQual: 30,
      minGenotypeQuality: 20,
      minDepth: 20,
      passOnly: false,
    });
  });

  it("lets a whole-exome VCF with no gene list through ingest", () => {
    const empty = { partner: { genes: "", hpo: "" } } as PartnerJobManifest;
    const panel = { partner: { genes: "CFTR", hpo: "" } } as PartnerJobManifest;
    expect(partnerSkipsGeneScope(null)).toBe(false);
    expect(partnerSkipsGeneScope(empty)).toBe(true);
    expect(partnerSkipsGeneScope(panel)).toBe(false);
  });

  it("stays queued until the VCF arrives and running while classification is in flight", () => {
    expect(
      partnerStatusFromParts({
        analysisStatus: "queued",
        awaitingVcf: true,
        activeRuns: 0,
        failedRuns: 0,
        succeededRuns: 0,
      })
    ).toBe("queued");
    expect(
      partnerStatusFromParts({
        analysisStatus: "review_ready",
        awaitingVcf: false,
        activeRuns: 2,
        failedRuns: 0,
        succeededRuns: 1,
      })
    ).toBe("running");
    expect(
      partnerStatusFromParts({
        analysisStatus: "review_ready",
        awaitingVcf: false,
        activeRuns: 0,
        failedRuns: 0,
        succeededRuns: 3,
      })
    ).toBe("succeeded");
    expect(
      partnerStatusFromParts({
        analysisStatus: "review_ready",
        awaitingVcf: false,
        activeRuns: 0,
        failedRuns: 2,
        succeededRuns: 0,
      })
    ).toBe("failed");
  });
});

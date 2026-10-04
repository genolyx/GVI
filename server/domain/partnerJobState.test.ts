import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ALLELE_FREQUENCY } from "@shared/germlineFrequency";
import { partnerInterpretationIdempotencyKey } from "@shared/partnerInterpretation";
import {
  partnerJobLookupId,
  partnerJobStorageKey,
  partnerStatusFromParts,
  partnerVcfFilters,
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

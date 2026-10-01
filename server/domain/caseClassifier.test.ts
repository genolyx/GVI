import { describe, expect, it } from "vitest";
import { classifierQueueMessage, type CaseClassifierQueue } from "./caseClassifier";

function result(partial: Partial<CaseClassifierQueue>): CaseClassifierQueue {
  return {
    queued: 0,
    skipped: [],
    worker: "not_needed",
    workerError: null,
    ...partial,
  };
}

describe("classifier queue message", () => {
  it("reports how many filtered variants entered the classifier", () => {
    expect(
      classifierQueueMessage(
        result({
          queued: 18,
          skipped: [{ variantId: 1, reason: "Needs a gene symbol and HGVSc" }],
          worker: "started",
        })
      )
    ).toBe(
      "Variant classifier queued for 18 variant(s). 1 variant(s) were skipped. Classifier worker started."
    );
  });

  it("says the classifier already finished when every variant was classified", () => {
    expect(
      classifierQueueMessage(
        result({ skipped: [{ variantId: 1, reason: "Already classified" }] })
      )
    ).toBe("Variant classifier already finished for these variants.");
  });

  it("includes a worker failure without hiding the queued count", () => {
    expect(
      classifierQueueMessage(
        result({ queued: 2, worker: "unavailable", workerError: "ENGINE_WORKER_TOKEN is not configured" })
      )
    ).toContain("queued for 2 variant(s)");
    expect(
      classifierQueueMessage(
        result({ queued: 2, worker: "unavailable", workerError: "ENGINE_WORKER_TOKEN is not configured" })
      )
    ).toContain("ENGINE_WORKER_TOKEN is not configured");
  });
});

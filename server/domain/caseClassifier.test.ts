import { describe, expect, it } from "vitest";
import { caseCurationBatchName, classifierQueueMessage, type CaseClassifierQueue } from "./caseClassifier";

function result(partial: Partial<CaseClassifierQueue>): CaseClassifierQueue {
  return {
    queued: 0,
    reused: 0,
    skipped: [],
    worker: "not_needed",
    workerError: null,
    ...partial,
  };
}

describe("case curation batch name", () => {
  it("names the batch after the case and keeps the case id", () => {
    expect(caseCurationBatchName("GVI-2026-0930", 57)).toBe("Case GVI-2026-0930 (#57)");
  });
});

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

  it("reports stored classifications that were reused instead of queued", () => {
    expect(classifierQueueMessage(result({ queued: 4, reused: 12, worker: "already_running" }))).toBe(
      "Variant classifier queued for 4 variant(s). Reused 12 stored classification(s) without calling the engine. Classifier worker is already running."
    );
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

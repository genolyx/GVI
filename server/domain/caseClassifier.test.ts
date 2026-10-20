import { describe, expect, it } from "vitest";
import {
  caseCurationBatchName,
  classifierQueueMessage,
  isBeyondIntronAutoWindow,
  type CaseClassifierQueue,
} from "./caseClassifier";

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

describe("intron auto-classification window", () => {
  it("keeps intronic changes within 20 bp of the exon", () => {
    expect(isBeyondIntronAutoWindow("c.444+1G>A", "splice_donor_variant")).toBe(false);
    expect(isBeyondIntronAutoWindow("c.100-20A>G", "intron_variant")).toBe(false);
    expect(isBeyondIntronAutoWindow("c.100-30_100-10del", "intron_variant")).toBe(false);
  });

  it("excludes intronic changes farther than 20 bp so they do not take a queue slot", () => {
    expect(isBeyondIntronAutoWindow("c.61-620G>A", "intron_variant")).toBe(true);
    expect(isBeyondIntronAutoWindow("c.479+598A>G", "intron_variant")).toBe(true);
    expect(isBeyondIntronAutoWindow("c.2995-86_2995-72del", "intron_variant")).toBe(true);
    expect(isBeyondIntronAutoWindow("c.100+21G>A", "intron_variant")).toBe(true);
  });

  it("still queues coding changes", () => {
    expect(isBeyondIntronAutoWindow("c.1486G>A", "missense_variant")).toBe(false);
    expect(isBeyondIntronAutoWindow("c.68_69del", "frameshift_variant")).toBe(false);
  });

  it("does not queue an intronic consequence when the offset cannot be read", () => {
    expect(isBeyondIntronAutoWindow("c.?", "intron_variant")).toBe(true);
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

import { describe, expect, it } from "vitest";
import { describeClassificationDivergence, suggestAcmgClassification } from "./acmg";

/**
 * The merge itself talks to Postgres and is covered by `scripts/curation-e2e.ts`.
 * What is unit-testable, and what actually carries clinical weight, is the rule
 * that an engine suggestion never counts as reviewed until a person touches it.
 */
describe("engine vs reviewer divergence", () => {
  const criteria = [
    { state: "met", origin: "engine" },
    { state: "met", origin: "engine" },
    { state: "met", origin: "human_confirmed" },
  ];

  it("reports the gap when the reviewer disagrees with the criteria", () => {
    const suggestion = suggestAcmgClassification(["PVS1", "PM2"]);
    const divergence = describeClassificationDivergence("VUS", suggestion, criteria);

    expect(suggestion.classification).toBe("Likely Pathogenic");
    expect(divergence.diverges).toBe(true);
    expect(divergence.recorded).toBe("VUS");
    expect(divergence.tierGap).toBe(1);
    expect(divergence.message).toMatch(/before signing/);
  });

  it("does not report divergence before anyone has classified the variant", () => {
    const divergence = describeClassificationDivergence(
      null,
      suggestAcmgClassification(["PVS1", "PM2"]),
      []
    );
    expect(divergence.diverges).toBe(false);
    expect(divergence.recorded).toBeNull();
  });

  it("counts only engine criteria a reviewer has not decided on", () => {
    const divergence = describeClassificationDivergence(
      "Likely Pathogenic",
      suggestAcmgClassification(["PVS1", "PM2"]),
      criteria
    );
    expect(divergence.diverges).toBe(false);
    expect(divergence.pendingEngineCriteria).toBe(2);
    expect(divergence.message).toMatch(/have not been accepted or rejected/);
  });

  it("stays silent once every engine suggestion has been reviewed", () => {
    const divergence = describeClassificationDivergence(
      "Likely Pathogenic",
      suggestAcmgClassification(["PVS1", "PM2"]),
      [{ state: "met", origin: "human_confirmed" }]
    );
    expect(divergence.pendingEngineCriteria).toBe(0);
    expect(divergence.message).toBeNull();
  });

  it("surfaces conflicting evidence ahead of the pending-review notice", () => {
    const divergence = describeClassificationDivergence(
      "VUS",
      suggestAcmgClassification(["PVS1", "BA1"]),
      criteria
    );
    // The reviewer agrees with the VUS the conflict produced, so the message must
    // explain the conflict rather than claim a disagreement.
    expect(divergence.diverges).toBe(false);
    expect(divergence.message).toMatch(/conflicting evidence/);
  });

  it("measures the tier gap across the full scale", () => {
    const divergence = describeClassificationDivergence(
      "Benign",
      suggestAcmgClassification(["PVS1", "PS1"]),
      []
    );
    expect(divergence.suggested).toBe("Pathogenic");
    expect(divergence.tierGap).toBe(4);
  });
});

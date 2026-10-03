import { describe, expect, it } from "vitest";
import { criteriaWithSavedReview, defaultStrengthForCode } from "./savedCriteria";

const pm2 = {
  code: "PM2",
  baseCode: "PM2",
  strength: "moderate" as const,
  direction: "pathogenic" as const,
  rationale: "Absent",
};

describe("criteriaWithSavedReview", () => {
  it("adds a PVS1 the reviewer applied on the classification tab", () => {
    const criteria = criteriaWithSavedReview([pm2], [
      { code: "PVS1", state: "met", strength: "very_strong", note: "Null variant in a loss-of-function gene." },
    ]);
    expect(criteria.map(item => item.code)).toEqual(["PM2", "PVS1"]);
    expect(criteria[1]).toMatchObject({
      baseCode: "PVS1",
      strength: "very_strong",
      rationale: "Null variant in a loss-of-function gene.",
    });
  });

  it("leaves a not-met code off the score", () => {
    expect(
      criteriaWithSavedReview([pm2], [{ code: "PVS1", state: "not_met", note: null }])
    ).toEqual([pm2]);
  });

  it("does not duplicate a code the engine already listed", () => {
    const criteria = criteriaWithSavedReview(
      [{ ...pm2, code: "PVS1", baseCode: "PVS1", strength: "very_strong", rationale: "Engine" }],
      [{ code: "PVS1", state: "met", note: "Reviewer note" }]
    );
    expect(criteria).toHaveLength(1);
    expect(criteria[0].rationale).toBe("Engine");
  });

  it("uses the code default when the saved strength is blank", () => {
    expect(defaultStrengthForCode("PVS1")).toBe("very_strong");
    const criteria = criteriaWithSavedReview([], [{ code: "PVS1", state: "met", strength: null, note: "Applied" }]);
    expect(criteria[0].strength).toBe("very_strong");
  });
});

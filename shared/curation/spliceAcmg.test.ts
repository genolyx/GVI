import { describe, expect, it } from "vitest";
import { criteriaWithSpliceReview, spliceReviewCriterion } from "./spliceAcmg";

const inFrameStrong =
  "<b>SOP logic:</b> in-frame skip removes 20.0% of the protein (&ge;10% threshold) &rarr; <b>PVS1_Strong</b> (in-frame deletion of a region considered critical to function).";

describe("spliceReviewCriterion", () => {
  it("reads PVS1_Strong from the in-frame splice calculation", () => {
    const criterion = spliceReviewCriterion({ splice_pvs1_logic_sentence: inFrameStrong });
    expect(criterion).toMatchObject({
      code: "PVS1",
      engineCode: "PVS1_Strong",
      strength: "strong",
    });
    expect(criterion?.rationale).toContain("PVS1_Strong");
    expect(criterion?.rationale).not.toContain("<b>");
  });

  it("reads very strong PVS1 from an out-of-frame splice calculation", () => {
    const criterion = spliceReviewCriterion({
      splice_pvs1_logic_sentence:
        "<b>SOP logic:</b> out-of-frame shift (54.7% of protein lost in the spliced product) &rarr; <b>PVS1</b> by default.",
    });
    expect(criterion).toMatchObject({ code: "PVS1", engineCode: "PVS1", strength: "very_strong" });
  });

  it("reads PM4 when the splice calculation stops at a small in-frame skip", () => {
    const criterion = spliceReviewCriterion({
      splice_pvs1_logic_sentence:
        "<b>SOP logic:</b> in-frame skip removes 4.0% of the protein (&lt;10% threshold) &rarr; <b>PM4</b>.",
    });
    expect(criterion).toMatchObject({ code: "PM4", engineCode: "PM4", strength: "moderate" });
  });

  it("returns null when the splice review did not name a code", () => {
    expect(spliceReviewCriterion({})).toBeNull();
    expect(spliceReviewCriterion({ splice_pvs1_logic_sentence: "no decision" })).toBeNull();
  });
});

describe("criteriaWithSpliceReview", () => {
  it("adds the splice code when the engine list omitted it", () => {
    const criteria = criteriaWithSpliceReview(
      [
        {
          code: "PM2",
          baseCode: "PM2",
          strength: "moderate",
          direction: "pathogenic",
          rationale: "Absent",
        },
      ],
      { splice_pvs1_logic_sentence: inFrameStrong }
    );
    expect(criteria.map(criterion => criterion.code)).toEqual(["PM2", "PVS1_Strong"]);
  });

  it("does not duplicate a code the engine already applied", () => {
    const criteria = criteriaWithSpliceReview(
      [
        {
          code: "PVS1_Strong",
          baseCode: "PVS1",
          strength: "strong",
          direction: "pathogenic",
          rationale: "Already applied",
        },
      ],
      { splice_pvs1_logic_sentence: inFrameStrong }
    );
    expect(criteria).toHaveLength(1);
  });
});

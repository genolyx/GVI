import { describe, expect, it } from "vitest";
import { acmgEvidenceBoard, withoutRemovedCriteria } from "./acmgBoard";
import type { CurationCriterion } from "./document";

const pm2: CurationCriterion = {
  code: "PM2",
  baseCode: "PM2",
  strength: "moderate",
  direction: "pathogenic",
  rationale: "Absent or extremely rare",
};

const pp3: CurationCriterion = {
  code: "PP3",
  baseCode: "PP3",
  strength: "supporting",
  direction: "pathogenic",
  rationale: "MetaDome indicates an intolerant residue",
};

describe("acmgEvidenceBoard", () => {
  it("keeps applied codes out of the wired and manual columns", () => {
    const board = acmgEvidenceBoard([pm2, pp3]);
    expect(board.found.map(item => item.baseCode)).toEqual(["PM2", "PP3"]);
    expect(board.wired.map(item => item.code)).not.toContain("PM2");
    expect(board.wired.map(item => item.code)).not.toContain("PP3");
    expect(board.wired.map(item => item.code)).toContain("BP7");
    expect(board.manual.map(item => item.code)).toContain("PS2");
    expect(board.manual.map(item => item.code)).not.toContain("PP5");
    expect(board.manual.map(item => item.code)).not.toContain("BP6");
  });

  it("moves a manual code into the found column once it is applied", () => {
    const board = acmgEvidenceBoard([
      {
        code: "PS3",
        baseCode: "PS3",
        strength: "strong",
        direction: "pathogenic",
        rationale: "Functional assay",
      },
    ]);
    expect(board.found.map(item => item.baseCode)).toContain("PS3");
    expect(board.manual.map(item => item.code)).not.toContain("PS3");
  });

  it("moves a removed code out of the found column so it can be applied again", () => {
    const kept = withoutRemovedCriteria([pm2, pp3], [{ code: "PM2", state: "not_met" }]);
    const board = acmgEvidenceBoard(kept);
    expect(board.found.map(item => item.baseCode)).toEqual(["PP3"]);
    expect(board.wired.map(item => item.code)).toContain("PM2");
  });

  it("puts an HGMD case-literature hit on PS4 in the lookup column", () => {
    const board = acmgEvidenceBoard([], {
      tag: "DM",
      pmids: ["27124789"],
      note: "HGMD DM. PMIDs 27124789. Check the papers for this variant in affected cases before applying PS4.",
    });
    const ps4 = board.manual.find(item => item.code === "PS4");
    expect(ps4?.detail).toContain("PMID");
    expect(ps4?.detail).toContain("not in the classification");
    expect(board.wired.map(item => item.code)).not.toContain("PS4");
  });
});

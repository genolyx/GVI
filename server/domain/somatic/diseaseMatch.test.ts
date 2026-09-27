import { describe, expect, it } from "vitest";
import {
  evidenceDiseaseConcept,
  matchPinnedDisease,
  type PinnedDiseaseConcept,
} from "./diseaseMatch";

const lung: PinnedDiseaseConcept = {
  ontologySystem: "OncoTree",
  ontologyVersion: "2026-09",
  code: "LUAD",
  ancestorCodes: ["NSCLC", "LUNG"],
  hierarchyComplete: true,
};

describe("version-pinned disease matching", () => {
  it("matches exact concepts without using labels", () => {
    expect(
      matchPinnedDisease(lung, {
        ontologySystem: "oncotree",
        ontologyVersion: "2026-09",
        code: "luad",
      })
    ).toBe("exact");
  });

  it("identifies explicit broader and narrower concepts", () => {
    expect(
      matchPinnedDisease(lung, {
        ontologySystem: "OncoTree",
        ontologyVersion: "2026-09",
        code: "NSCLC",
      })
    ).toBe("broader");
    expect(
      matchPinnedDisease(lung, {
        ontologySystem: "OncoTree",
        ontologyVersion: "2026-09",
        code: "LUAD-SUBTYPE",
        ancestorCodes: ["LUAD", "NSCLC", "LUNG"],
      })
    ).toBe("narrower");
  });

  it("fails closed across versions and incomplete hierarchies", () => {
    expect(
      matchPinnedDisease(lung, {
        ontologySystem: "OncoTree",
        ontologyVersion: "2025-01",
        code: "LUAD",
      })
    ).toBe("unknown");
    expect(
      matchPinnedDisease(
        { ...lung, ancestorCodes: undefined, hierarchyComplete: undefined },
        {
          ontologySystem: "OncoTree",
          ontologyVersion: "2026-09",
          code: "NSCLC",
        }
      )
    ).toBe("unknown");
  });

  it("returns none only when both hierarchies are explicitly complete", () => {
    expect(
      matchPinnedDisease(lung, {
        ontologySystem: "OncoTree",
        ontologyVersion: "2026-09",
        code: "MEL",
        ancestorCodes: ["SKIN"],
        hierarchyComplete: true,
      })
    ).toBe("none");
  });

  it("accepts only structured ontology payloads", () => {
    expect(
      evidenceDiseaseConcept({
        diseaseOntology: {
          ontologySystem: "OncoTree",
          ontologyVersion: "2026-09",
          code: "LUAD",
        },
      })
    ).toMatchObject({ code: "LUAD" });
    expect(evidenceDiseaseConcept({ diseaseName: "lung cancer" })).toBeNull();
  });
});


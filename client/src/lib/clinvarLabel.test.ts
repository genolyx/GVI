import { describe, expect, it } from "vitest";
import { clinvarShortLabels } from "./clinvarLabel";

describe("ClinVar short labels", () => {
  it("maps a single call", () => {
    expect(clinvarShortLabels("uncertain significance")).toEqual(["VUS"]);
    expect(clinvarShortLabels("Pathogenic")).toEqual(["Path"]);
    expect(clinvarShortLabels("Likely pathogenic")).toEqual(["LP"]);
    expect(clinvarShortLabels("Benign")).toEqual(["Benign"]);
    expect(clinvarShortLabels("Likely benign")).toEqual(["LB"]);
  });

  it("keeps each call in a mixed record and drops the long conflict phrase", () => {
    expect(
      clinvarShortLabels(
        "uncertain significance&conflicting interpretations of pathogenicity&benign/likely benign",
      ),
    ).toEqual(["VUS", "LB", "Benign"]);
    expect(clinvarShortLabels("uncertain significance&pathogenic&conflicting interpretations of pathogenicity")).toEqual([
      "Path",
      "VUS",
    ]);
  });

  it("does not treat pathogenicity as pathogenic", () => {
    expect(clinvarShortLabels("conflicting interpretations of pathogenicity")).toEqual(["Conflict"]);
    expect(clinvarShortLabels("conflicting interpretations of pathogenicity&likely benign")).toEqual(["LB"]);
  });
});

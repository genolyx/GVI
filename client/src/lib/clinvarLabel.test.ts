import { describe, expect, it } from "vitest";
import { clinvarRecordUrl, clinvarShortLabels } from "./clinvarLabel";

describe("ClinVar short labels", () => {
  it("maps a single call", () => {
    expect(clinvarShortLabels("uncertain significance")).toEqual(["VUS"]);
    expect(clinvarShortLabels("Pathogenic")).toEqual(["P"]);
    expect(clinvarShortLabels("Likely pathogenic")).toEqual(["LP"]);
    expect(clinvarShortLabels("Benign")).toEqual(["B"]);
    expect(clinvarShortLabels("Likely benign")).toEqual(["LB"]);
  });

  it("keeps each call in a mixed record and drops the long conflict phrase", () => {
    expect(
      clinvarShortLabels(
        "uncertain significance&conflicting interpretations of pathogenicity&benign/likely benign",
      ),
    ).toEqual(["VUS", "LB", "B"]);
    expect(clinvarShortLabels("uncertain significance&pathogenic&conflicting interpretations of pathogenicity")).toEqual([
      "P",
      "VUS",
    ]);
  });

  it("does not treat pathogenicity as pathogenic", () => {
    expect(clinvarShortLabels("conflicting interpretations of pathogenicity")).toEqual(["Conflict"]);
    expect(clinvarShortLabels("Conflicting classifications of pathogenicity")).toEqual(["Conflict"]);
    expect(clinvarShortLabels("conflicting interpretations of pathogenicity&likely benign")).toEqual(["LB"]);
  });

  it("links a held call to the ClinVar record for that transcript change", () => {
    expect(
      clinvarRecordUrl({
        gene: "SHPK",
        transcript: "NM_013276.4",
        hgvsC: "c.355C>T",
      }),
    ).toBe("https://www.ncbi.nlm.nih.gov/clinvar/?term=NM_013276.4(SHPK)%3Ac.355C%3ET");
    expect(clinvarRecordUrl({ gene: "SHPK", transcript: null, hgvsC: null })).toBeNull();
  });
});

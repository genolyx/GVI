import { describe, expect, it } from "vitest";
import { classificationFastLabels, classificationFastShort } from "./classificationSearch";

describe("classification fast search", () => {
  it("maps each button to the stored classification and nothing broader", () => {
    expect(classificationFastLabels("P")).toEqual(["pathogenic"]);
    expect(classificationFastLabels("LP")).toEqual(["likely pathogenic"]);
    expect(classificationFastLabels("B")).toEqual(["benign"]);
    expect(classificationFastLabels("VUS")).toContain("vus");
    expect(classificationFastLabels("nope")).toBeNull();
  });

  it("shows the short name used on the button", () => {
    expect(classificationFastShort("Pathogenic")).toBe("P");
    expect(classificationFastShort("Likely pathogenic")).toBe("LP");
    expect(classificationFastShort("Likely Benign")).toBe("LB");
    expect(classificationFastShort("VUS")).toBe("VUS");
    expect(classificationFastShort("Benign")).toBe("B");
  });
});

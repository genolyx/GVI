import { describe, expect, it } from "vitest";
import { frequencyTrackForOrder } from "./germlineFrequency";

describe("frequency track from the order", () => {
  it("uses the package code when the stored category is still carrier", () => {
    expect(
      frequencyTrackForOrder({
        testCategory: "standard_carrier",
        packageCode: "WholeExome",
      })
    ).toBe("rare_disease");
    expect(
      frequencyTrackForOrder({
        testCategory: "other",
        packageCode: "HereditaryCancer",
      })
    ).toBe("hereditary_cancer");
    expect(
      frequencyTrackForOrder({
        testCategory: "other",
        otherTestType: "ExomeTrio",
        packageCode: "ExomeTrio",
      })
    ).toBe("rare_disease");
    expect(
      frequencyTrackForOrder({
        testCategory: "standard_carrier",
        packageCode: "CarrierScreening",
      })
    ).toBe("carrier");
    expect(
      frequencyTrackForOrder({
        testCategory: "standard_carrier",
        packageCode: "HealthScreening",
      })
    ).toBe("carrier");
  });
});

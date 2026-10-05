import { describe, expect, it } from "vitest";
import {
  defaultGermlineOrder,
  germlineOrderMissing,
  germlineOrderRow,
  germlineServiceFromStored,
  normalizeGermlineOrder,
} from "./germlineOrder";

describe("germline service package codes", () => {
  it("keeps carrier screening on CarrierScreening", () => {
    const order = normalizeGermlineOrder({
      ...defaultGermlineOrder,
      service: "carrier_screening",
      reportMode: "couples",
      partnerCaseNumber: "CS-2",
    });
    expect(order.testCategory).toBe("standard_carrier");
    expect(order.packageCode).toBe("CarrierScreening");
    expect(order.reportMode).toBe("couples");
    expect(order.partnerCaseNumber).toBe("CS-2");
  });

  it("stores whole exome as carrier category with WholeExome", () => {
    const row = germlineOrderRow({
      ...defaultGermlineOrder,
      service: "whole_exome",
      reportMode: "couples",
      partnerCaseNumber: "CS-2",
      patient2Name: "Partner",
    });
    expect(row.testCategory).toBe("standard_carrier");
    expect(row.packageCode).toBe("WholeExome");
    expect(row.otherTestType).toBeNull();
    expect(row.reportMode).toBe("single");
    expect(row.partnerCaseNumber).toBeNull();
    expect(row.patient2Name).toBeNull();
  });

  it("stores health screening as HealthScreening", () => {
    const order = normalizeGermlineOrder({
      ...defaultGermlineOrder,
      service: "health_screening",
    });
    expect(order.testCategory).toBe("standard_carrier");
    expect(order.packageCode).toBe("HealthScreening");
  });

  it("uses the extended program as the package code and opens trio patients", () => {
    const order = normalizeGermlineOrder({
      ...defaultGermlineOrder,
      service: "extended_services",
      otherTestType: "ExomeTrio",
      patient2Name: "Parent",
      patient3Name: "Sibling",
    });
    expect(order.testCategory).toBe("other");
    expect(order.packageCode).toBe("ExomeTrio");
    expect(order.otherTestType).toBe("ExomeTrio");
    expect(order.patient2Name).toBe("Parent");
    expect(order.patient3Name).toBe("Sibling");
  });

  it("drops trio patients when the program does not need them", () => {
    const order = normalizeGermlineOrder({
      ...defaultGermlineOrder,
      service: "extended_services",
      otherTestType: "HereditaryCancer",
      patient2Name: "Parent",
      patient3Name: "Sibling",
    });
    expect(order.packageCode).toBe("HereditaryCancer");
    expect(order.patient2Name).toBe("");
    expect(order.patient3Name).toBe("");
  });

  it("lists the Service Portal fields that are still empty", () => {
    expect(germlineOrderMissing(defaultGermlineOrder)).toEqual([
      "Patient name",
      "Patient birth",
      "Patient gender",
      "Affected",
      "Sample collection date",
    ]);
    expect(
      germlineOrderMissing({
        ...defaultGermlineOrder,
        service: "whole_exome",
        reportMode: "couples",
      })
    ).not.toContain("Partner order ID");
  });

  it("recognizes a stored whole exome package", () => {
    expect(
      germlineServiceFromStored({
        testCategory: "standard_carrier",
        packageCode: "WholeExome",
      })
    ).toBe("whole_exome");
    expect(
      germlineServiceFromStored({
        testCategory: "other",
        packageCode: "HereditaryCancer",
      })
    ).toBe("extended_services");
  });
});

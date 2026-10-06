import { describe, expect, it } from "vitest";
import {
  regimensEquivalent,
  resolveDrugId,
  type DrugCatalog,
} from "./drugs";

const catalog: DrugCatalog = {
  version: "test",
  drugs: [
    {
      id: "drug-osi",
      aliases: [
        { source: "nccn", kind: "generic", name: "osimertinib" },
        { source: "oncokb", kind: "brand", name: "Tagrisso" },
        { source: "civic", kind: "abbreviation", name: "osi" },
        { source: "ncit", kind: "biosimilar", name: "osimertinib-biosimilar" },
      ],
      classIds: ["class-egfr-tki"],
      fda: "approved",
      mfds: "approved",
      offLabel: false,
    },
    {
      id: "drug-erl",
      aliases: [{ source: "oncokb", kind: "generic", name: "Erlotinib" }],
      classIds: ["class-egfr-tki"],
      fda: "approved",
      mfds: "unknown",
      offLabel: false,
    },
  ],
  classes: [{ id: "class-egfr-tki", memberDrugIds: ["drug-osi", "drug-erl"] }],
  regimens: [],
};

describe("NCCN drug identity", () => {
  it("maps brand, abbreviation, and biosimilar names onto one internal id", () => {
    expect(resolveDrugId(catalog, "Tagrisso", "oncokb")).toBe("drug-osi");
    expect(resolveDrugId(catalog, "osi", "civic")).toBe("drug-osi");
    expect(resolveDrugId(catalog, "osimertinib-biosimilar", "ncit")).toBe("drug-osi");
  });

  it("leaves an unknown or cross-source name unmapped", () => {
    expect(resolveDrugId(catalog, "Tagrisso", "nccn")).toBeNull();
    expect(resolveDrugId(catalog, "amivantamab", "oncokb")).toBeNull();
  });

  it("treats an unordered combination as the same regimen and a reversed sequence as different", () => {
    const combination = {
      id: "combo",
      drugIds: ["drug-b", "drug-a"],
      combinationType: "combination" as const,
      orderMatters: false,
    };
    expect(
      regimensEquivalent(combination, {
        ...combination,
        id: "combo-other",
        drugIds: ["drug-a", "drug-b"],
      })
    ).toBe(true);
    expect(
      regimensEquivalent(
        {
          id: "seq",
          drugIds: ["drug-a", "drug-b"],
          combinationType: "sequential",
          orderMatters: true,
        },
        {
          id: "seq-reverse",
          drugIds: ["drug-b", "drug-a"],
          combinationType: "sequential",
          orderMatters: true,
        }
      )
    ).toBe(false);
    expect(
      regimensEquivalent(combination, {
        id: "mono",
        drugIds: ["drug-a"],
        combinationType: "monotherapy",
        orderMatters: false,
      })
    ).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import {
  codingKey,
  isPlainPathogenicCall,
  isReducedPenetranceCall,
  keepsAtAnyFrequency,
  type AlleleIdentity,
} from "./frequencyPolicy";

const carrier = {
  track: "carrier" as const,
  inheritance: new Map([
    ["HBB", "AR"],
    ["GJB2", "AR"],
    ["HFE", "AR"],
    ["MUTYH", "AR"],
    ["BRCA1", "AD"],
    ["CFTR", "AR"],
    ["G6PD", "X-linked"],
    ["ATP7B", "AD/AR"],
  ]),
};

function allele(patch: Partial<AlleleIdentity> & Pick<AlleleIdentity, "gene">): AlleleIdentity {
  return {
    hgvsC: null,
    hgvsP: null,
    clinvarSignificance: "Pathogenic",
    ...patch,
  };
}

describe("ClinVar penetrance terms", () => {
  it("treats a low-penetrance or risk-allele phrase as reduced, including a mixed aggregate", () => {
    expect(isReducedPenetranceCall("Pathogenic, low penetrance")).toBe(true);
    expect(isReducedPenetranceCall("Pathogenic/Pathogenic, low penetrance")).toBe(true);
    expect(isReducedPenetranceCall("Likely_pathogenic,_low_penetrance")).toBe(true);
    expect(isReducedPenetranceCall("Established risk allele")).toBe(true);
    expect(isPlainPathogenicCall("Pathogenic/Likely pathogenic")).toBe(true);
    expect(isPlainPathogenicCall("Pathogenic/Pathogenic, low penetrance")).toBe(false);
    expect(isPlainPathogenicCall("Benign/Likely pathogenic")).toBe(false);
    expect(isPlainPathogenicCall("Conflicting interpretations of pathogenicity")).toBe(false);
  });

  it("matches del and dup alleles with or without the trailing bases", () => {
    expect(codingKey("NM_007294.4:c.68_69delAG")).toBe("68_69del");
    expect(codingKey("c.5266dupC")).toBe("5266dup");
    expect(codingKey("c.1100del")).toBe("1100del");
    expect(codingKey("c.*96A>G")).toBe("*96a>g");
  });
});

describe("frequency exemptions", () => {
  it("keeps a common recessive pathogenic allele and drops a named mild one", () => {
    expect(
      keepsAtAnyFrequency(
        allele({ gene: "HBB", hgvsC: "c.20A>T", hgvsP: "p.Glu7Val" }),
        carrier
      )
    ).toBe(true);
    expect(
      keepsAtAnyFrequency(
        allele({ gene: "GJB2", hgvsC: "c.109G>A", hgvsP: "p.Val37Ile" }),
        carrier
      )
    ).toBe(false);
    expect(
      keepsAtAnyFrequency(
        allele({
          gene: "HFE",
          hgvsC: "c.845G>A",
          hgvsP: "p.Cys282Tyr",
          clinvarSignificance: "Pathogenic/Pathogenic, low penetrance",
        }),
        carrier
      )
    ).toBe(false);
    expect(
      keepsAtAnyFrequency(
        allele({ gene: "CFTR", hgvsC: "NM_000492.4:c.350G>A", hgvsP: "p.Arg117His" }),
        carrier
      )
    ).toBe(false);
  });

  it("counts a gene that is both AD and AR as recessive, and keeps X-linked off the cancer track", () => {
    expect(
      keepsAtAnyFrequency(allele({ gene: "ATP7B", hgvsC: "c.1A>G" }), carrier)
    ).toBe(true);
    expect(
      keepsAtAnyFrequency(allele({ gene: "G6PD", hgvsC: "c.563C>T", hgvsP: "p.Ser188Phe" }), {
        ...carrier,
        track: "hereditary_cancer",
      })
    ).toBe(false);
    expect(
      keepsAtAnyFrequency(allele({ gene: "MUTYH", hgvsC: "c.1A>G" }), {
        ...carrier,
        track: "hereditary_cancer",
      })
    ).toBe(true);
  });

  it("keeps named cancer founders only on the cancer track", () => {
    const founder = allele({
      gene: "BRCA1",
      hgvsC: "c.68_69delAG",
      clinvarSignificance: "Pathogenic",
    });
    expect(keepsAtAnyFrequency(founder, carrier)).toBe(false);
    expect(
      keepsAtAnyFrequency(founder, { ...carrier, track: "hereditary_cancer" })
    ).toBe(true);
    expect(
      keepsAtAnyFrequency(
        allele({ gene: "CHEK2", hgvsC: "c.1100delC", clinvarSignificance: "Pathogenic" }),
        { ...carrier, track: "hereditary_cancer" }
      )
    ).toBe(true);
  });
});

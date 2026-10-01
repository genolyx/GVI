import { describe, expect, it } from "vitest";
import { indexOmimTable, shortInheritance } from "./omimCatalog";

const TABLE = [
  "gene_symbol\tmim_disease_id\tmim_phenotypes_id\tmim_phenotype_name\tmim_disease_name\tmim_inheritance\tmiscelaneous_clinical_notes",
  "MEFV\t134610\t134610\tFamilial Mediterranean fever,AD\tFAMILIAL MEDITERRANEAN FEVER; FMF\tAutosomal dominant\t",
  "MEFV\t249100\t249100\tFamilial Mediterranean fever,AR\tFAMILIAL MEDITERRANEAN FEVER; FMF\tAutosomal recessive\t",
  "MEFV\t249100\t249100\tFamilial Mediterranean fever,AR\tFAMILIAL MEDITERRANEAN FEVER; FMF\tAutosomal recessive\t",
  "TP53\t114480\t114480\tBreast cancer,somatic\tBREAST CANCER\t\t",
  "RRAS2\t618624\t618624\tNoonan syndrome 12\tNOONAN SYNDROME 12; NS12\tAutosomal dominant/Autosomal recessive\t",
  "TEX11\t309120\t309120\tSpermatogenic failure,X-linked 2\tSPERMATOGENIC FAILURE\tX-linked recessive\t",
  'TRMT10C\t616974\t616974\t\tCOMBINED OXIDATIVE PHOSPHORYLATION DEFICIENCY 30; COXPD30\tAutosomal recessive\t"Note line',
  'still the note"',
].join("\n");

describe("OMIM catalog", () => {
  it("shortens inheritance to AR, AD, and X-linked", () => {
    expect(shortInheritance("Autosomal recessive")).toBe("AR");
    expect(shortInheritance("Autosomal dominant")).toBe("AD");
    expect(shortInheritance("X-linked recessive")).toBe("X-linked");
    expect(shortInheritance("X-linked dominant")).toBe("X-linked");
    expect(shortInheritance("Autosomal dominant/Autosomal recessive")).toBe("AD/AR");
    expect(shortInheritance("?Autosomal dominant")).toBe("AD");
    expect(shortInheritance("Somatic mutation")).toBe("");
  });

  it("indexes disease name, inheritance, and the OMIM entry link", () => {
    const index = indexOmimTable(TABLE);
    expect(index.get("MEFV")).toEqual([
      {
        omimId: "134610",
        url: "https://omim.org/entry/134610",
        inheritance: "AD",
        disease: "Familial Mediterranean fever,AD",
      },
      {
        omimId: "249100",
        url: "https://omim.org/entry/249100",
        inheritance: "AR",
        disease: "Familial Mediterranean fever,AR",
      },
    ]);
    expect(index.get("TP53")?.[0].inheritance).toBe("");
    expect(index.get("RRAS2")?.[0].inheritance).toBe("AD/AR");
    expect(index.get("TEX11")?.[0].inheritance).toBe("X-linked");
    expect(index.get("TRMT10C")?.[0].disease).toBe("COMBINED OXIDATIVE PHOSPHORYLATION DEFICIENCY 30");
  });
});

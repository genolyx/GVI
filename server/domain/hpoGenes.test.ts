import { describe, expect, it } from "vitest";
import { geneSetFromMatches, genesForTerms, indexPhenotypeToGenes, searchHpoTerms } from "./hpoGenes";

const TABLE = [
  "hpo_id\thpo_name\tncbi_gene_id\tgene_symbol\tdisease_id",
  "HP:0001250\tSeizure\t1\tSCN1A\tOMIM:1",
  "HP:0001250\tSeizure\t2\tSCN2A\tOMIM:2",
  "HP:0002123\tGeneralized myoclonic seizure\t1\tSCN1A\tOMIM:1",
  "HP:0009830\tPeripheral neuropathy\t3\tPMP22\tOMIM:3",
].join("\n");

describe("HPO gene lookup", () => {
  const index = indexPhenotypeToGenes(TABLE);

  it("resolves an HPO id and a phenotype name to gene symbols", () => {
    const byId = genesForTerms(index, "HP:0001250");
    expect(geneSetFromMatches(byId.matches)).toEqual(new Set(["SCN1A", "SCN2A"]));
    const byName = genesForTerms(index, "peripheral neuropathy");
    expect(geneSetFromMatches(byName.matches)).toEqual(new Set(["PMP22"]));
    expect(byName.unmatched).toEqual([]);
  });

  it("includes a more specific term when the query is a whole word in its name", () => {
    const found = genesForTerms(index, "seizure");
    const ids = found.matches.map(match => match.id).sort();
    expect(ids).toEqual(["HP:0001250", "HP:0002123"]);
  });

  it("reports a term that is not in the table", () => {
    expect(genesForTerms(index, "not a phenotype").unmatched).toEqual(["not a phenotype"]);
  });

  it("ranks the closest phenotype name and tolerates a missing letter", () => {
    expect(searchHpoTerms(index, "sei").map(item => item.name)).toEqual([
      "Seizure",
      "Generalized myoclonic seizure",
    ]);
    expect(searchHpoTerms(index, "seizur")[0]).toMatchObject({ id: "HP:0001250", name: "Seizure" });
    expect(searchHpoTerms(index, "HP:00098")[0]).toMatchObject({ id: "HP:0009830", name: "Peripheral neuropathy" });
    expect(searchHpoTerms(index, "neuropthy")[0]?.name).toBe("Peripheral neuropathy");
    expect(searchHpoTerms(index, "z")).toEqual([]);
  });
});

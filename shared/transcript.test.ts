import { describe, expect, it } from "vitest";
import { codingHgvs, displayHgvs, displayTranscript, refseqTranscript } from "./transcript";

describe("clinical transcript display", () => {
  it("keeps a RefSeq accession and strips an Ensembl HGVS prefix", () => {
    expect(refseqTranscript("NM_003322.6")).toBe("NM_003322.6");
    expect(codingHgvs("ENST00000229771.11:c.1486G>A")).toBe("c.1486G>A");
    expect(displayHgvs("NM_003322.6", "c.1486G>A")).toBe("NM_003322.6:c.1486G>A");
    expect(displayTranscript("NM_003322.6")).toBe("NM_003322.6");
  });

  it("does not treat an Ensembl id as the clinical transcript", () => {
    expect(refseqTranscript("ENST00000229771.11")).toBe("");
    expect(displayTranscript("ENST00000229771")).toBe("ENST00000229771");
    expect(displayHgvs("ENST00000229771.11", "ENST00000229771.11:c.1486G>A")).toBe("c.1486G>A");
  });
});

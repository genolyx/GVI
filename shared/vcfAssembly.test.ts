import { describe, expect, it } from "vitest";
import { detectReferenceBuild } from "./vcfAssembly";

describe("VCF reference build detection", () => {
  it("reads hg38 from the reference line and chr1 length", () => {
    const detected = detectReferenceBuild(`##fileformat=VCFv4.2
##reference=file:///refs/Homo_sapiens_assembly38.fasta
##contig=<ID=chr1,length=248956422,assembly=GRCh38>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
`);
    expect(detected).toMatchObject({
      build: "GRCh38",
      commonName: "hg38",
      source: "contig-length",
    });
  });

  it("reads hg19 from a reference path when contig lengths are absent", () => {
    const detected = detectReferenceBuild(`##fileformat=VCFv4.2
##reference=gs://refs/hg19.fa
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
`);
    expect(detected).toMatchObject({
      build: "GRCh37",
      commonName: "hg19",
      source: "header",
    });
  });

  it("uses GRCh37 contig length when the header never names the assembly", () => {
    const detected = detectReferenceBuild(`##fileformat=VCFv4.2
##contig=<ID=1,length=249250621>
##contig=<ID=X,length=155270560>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
`);
    expect(detected?.build).toBe("GRCh37");
  });

  it("trusts contig length when another header line mentions the other build", () => {
    const detected = detectReferenceBuild(`##fileformat=VCFv4.2
##INFO=<ID=OLD,Number=0,Type=Flag,Description="Site was also called on hg19">
##reference=hg19
##contig=<ID=chr1,length=248956422>
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
`);
    expect(detected).toMatchObject({ build: "GRCh38", source: "contig-length" });
  });

  it("leaves the choice open when the header has no assembly evidence", () => {
    expect(
      detectReferenceBuild(`##fileformat=VCFv4.2
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO
`)
    ).toBeNull();
  });
});

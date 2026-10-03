import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bgzfMemberLength, isVcfFileName, readVcfHeader } from "./readVcfHeader";

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc >>> 0;
}

function bgzfBlock(text: string): Buffer {
  const raw = Buffer.from(text);
  const deflated = deflateRawSync(raw);
  const bsize = 18 + deflated.length + 8 - 1;
  const header = Buffer.alloc(18);
  header[0] = 0x1f;
  header[1] = 0x8b;
  header[2] = 8;
  header[3] = 4;
  header[9] = 0xff;
  header.writeUInt16LE(6, 10);
  header[12] = 0x42;
  header[13] = 0x43;
  header.writeUInt16LE(2, 14);
  header.writeUInt16LE(bsize, 16);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw) >>> 0, 0);
  trailer.writeUInt32LE(raw.length, 4);
  return Buffer.concat([header, deflated, trailer]);
}

describe("VCF file selection", () => {
  it("accepts a gzipped VCF name", () => {
    expect(isVcfFileName("OC230800004_deepvariant_filtered.vcf.gz")).toBe(true);
    expect(isVcfFileName("sample.vcf")).toBe(true);
    expect(isVcfFileName("notes.txt")).toBe(false);
  });

  it("reads a header split across DeepVariant bgzip blocks", async () => {
    const first = bgzfBlock("##fileformat=VCFv4.2\n##reference=GRCh38\n");
    const bytes = Buffer.concat([
      first,
      bgzfBlock("#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"),
    ]);
    expect(bgzfMemberLength(bytes)).toBe(first.length);
    const header = await readVcfHeader(new Blob([bytes]));
    expect(header).toContain("##fileformat=VCFv4.2");
    expect(header).toContain("##reference=GRCh38");
    expect(header).toContain("#CHROM");
  });
});

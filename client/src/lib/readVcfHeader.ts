const HEADER_LIMIT = 4_000_000;
const GZIP_WINDOW = 256 * 1024;

function headerText(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.startsWith("#")) {
      if (line.length) break;
      continue;
    }
    lines.push(line);
    if (line.startsWith("#CHROM")) break;
  }
  return lines.join("\n");
}

function headerComplete(text: string): boolean {
  return text.split(/\r?\n/).some(line => line.startsWith("#CHROM") || (line.length > 0 && !line.startsWith("#")));
}

/** A .vcf or gzipped VCF. macOS also uses .vcf for vCards, so the name is checked after the picker. */
export function isVcfFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".vcf") || lower.endsWith(".vcf.gz") || lower.endsWith(".vcf.bgz");
}

/**
 * Length of one BGZF block starting at `start`.
 * DeepVariant writes bgzip, which is many small gzip members. A plain gzip file returns null.
 */
export function bgzfMemberLength(bytes: Uint8Array, start = 0): number | null {
  if (start + 18 > bytes.length) return null;
  if (bytes[start] !== 0x1f || bytes[start + 1] !== 0x8b || bytes[start + 2] !== 8) return null;
  const flags = bytes[start + 3] ?? 0;
  if ((flags & 0x04) === 0) return null;
  const offset = start + 10;
  const xlen = bytes[offset]! | (bytes[offset + 1]! << 8);
  const extraEnd = offset + 2 + xlen;
  if (extraEnd > bytes.length) return null;
  let cursor = offset + 2;
  while (cursor + 4 <= extraEnd) {
    const si1 = bytes[cursor]!;
    const si2 = bytes[cursor + 1]!;
    const slen = bytes[cursor + 2]! | (bytes[cursor + 3]! << 8);
    if (si1 === 0x42 && si2 === 0x43 && slen === 2 && cursor + 6 <= extraEnd) {
      const bsize = bytes[cursor + 4]! | (bytes[cursor + 5]! << 8);
      return bsize + 1;
    }
    cursor += 4 + slen;
  }
  return null;
}

async function inflateGzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function readPlainGzip(file: Blob): Promise<string> {
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < HEADER_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (headerComplete(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** Read only the VCF header, including plain gzip and DeepVariant bgzip. */
export async function readVcfHeader(file: Blob): Promise<string> {
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzip = signature[0] === 0x1f && signature[1] === 0x8b;
  if (!gzip) {
    return headerText(await file.slice(0, HEADER_LIMIT).text());
  }
  let text = "";
  let offset = 0;
  while (offset < file.size && text.length < HEADER_LIMIT) {
    const window = new Uint8Array(await file.slice(offset, offset + GZIP_WINDOW).arrayBuffer());
    const memberLength = bgzfMemberLength(window, 0);
    if (memberLength == null) {
      if (offset === 0) text = await readPlainGzip(file);
      break;
    }
    const member =
      memberLength <= window.length
        ? window.subarray(0, memberLength)
        : new Uint8Array(await file.slice(offset, offset + memberLength).arrayBuffer());
    text += await inflateGzip(member);
    offset += memberLength;
    if (headerComplete(text)) break;
  }
  return headerText(text);
}

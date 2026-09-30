const HEADER_LIMIT = 4_000_000;

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

/** Read only the VCF header, including the start of a .vcf.gz file. */
export async function readVcfHeader(file: File): Promise<string> {
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzip = signature[0] === 0x1f && signature[1] === 0x8b;
  if (!gzip) {
    return headerText(await file.slice(0, HEADER_LIMIT).text());
  }
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
  return headerText(text);
}

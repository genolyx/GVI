/** RefSeq NM accession. Ensembl ids are not a clinical transcript. */
export function refseqTranscript(transcript: string | null | undefined): string {
  const value = (transcript || "").trim().split(/[|:]/)[0] || "";
  const match = /^NM_\d+(?:\.\d+)?/i.exec(value);
  return match ? match[0] : "";
}

/** Coding or protein change without an accession prefix. */
export function codingHgvs(hgvs: string | null | undefined): string {
  const value = (hgvs || "").trim();
  if (!value) return "";
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const change = value.slice(colon + 1);
    if (/^[cnpg]\./i.test(change)) return change;
  }
  return value;
}

/**
 * Transcript cell, matching Service Portal: MANE RefSeq when present,
 * otherwise the stored transcript (often Ensembl).
 */
export function displayTranscript(transcript: string | null | undefined): string {
  return refseqTranscript(transcript) || (transcript || "").trim();
}

/** One-line identity: `NM_003322.6:c.1486G>A` when a RefSeq transcript is known. */
export function displayHgvs(transcript: string | null | undefined, hgvs: string | null | undefined): string {
  const change = codingHgvs(hgvs);
  const nm = refseqTranscript(transcript);
  if (nm && change) return `${nm}:${change}`;
  return change || nm;
}

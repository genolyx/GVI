/**
 * Turn an HGVS p. string into the protein-change token OncoKB and CIViC use
 * (`V600E`, `G12D`, `R213*`).
 *
 * VCF annotation writes both 1-letter (`p.G933V`) and 3-letter (`p.Gly933Val`)
 * forms. The knowledge bases expect the compact 1-letter token without the
 * `p.` prefix.
 */

const AA3_TO_1: Record<string, string> = {
  ALA: "A",
  ARG: "R",
  ASN: "N",
  ASP: "D",
  CYS: "C",
  GLN: "Q",
  GLU: "E",
  GLY: "G",
  HIS: "H",
  ILE: "I",
  LEU: "L",
  LYS: "K",
  MET: "M",
  PHE: "F",
  PRO: "P",
  SER: "S",
  THR: "T",
  TRP: "W",
  TYR: "Y",
  VAL: "V",
  TER: "*",
  STOP: "*",
};

function aaToOne(token: string): string | null {
  const upper = token.toUpperCase();
  if (upper === "X" || upper === "*") return "*";
  if (upper.length === 1 && /[A-Z*]/.test(upper)) return upper;
  return AA3_TO_1[upper] ?? null;
}

export function proteinChangeFromHgvs(hgvsP: string | null | undefined): string | null {
  if (!hgvsP) return null;
  const raw = hgvsP
    .trim()
    .replace(/^p\./i, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, "");
  if (!raw) return null;

  const three = raw.match(/^([A-Za-z]{3})(\d+)([A-Za-z]{3}|\*|X|=|fs\b.*)$/i);
  if (three) {
    const from = aaToOne(three[1]);
    const pos = three[2];
    const toRaw = three[3];
    if (from && /fs/i.test(toRaw)) return `${from}${pos}fs`;
    if (toRaw === "=") return `${from}${pos}${from}`;
    const to = aaToOne(toRaw);
    if (from && to) return `${from}${pos}${to}`;
  }

  const one = raw.match(/^([A-Z*])(\d+)([A-Z*=]|fs\b.*)$/i);
  if (one) {
    const from = aaToOne(one[1]);
    const pos = one[2];
    if (from && /fs/i.test(one[3])) return `${from}${pos}fs`;
    if (one[3] === "=") return `${from}${pos}${from}`;
    const to = aaToOne(one[3]);
    if (from && to) return `${from}${pos}${to}`;
  }

  return null;
}

/** Names CIViC might use for the same protein change. */
export function proteinChangeAliases(change: string): string[] {
  const compact = change.replace(/^p\./i, "").replace(/\s+/g, "");
  return Array.from(new Set([compact, `p.${compact}`, compact.toUpperCase(), `p.${compact.toUpperCase()}`]));
}

export function civicVariantMatches(civicName: string, change: string): boolean {
  const left = civicName.replace(/^p\./i, "").replace(/\s+/g, "").toUpperCase();
  const right = change.replace(/^p\./i, "").replace(/\s+/g, "").toUpperCase();
  if (!left || !right) return false;
  return left === right || left === `P.${right}` || right === `P.${left}`;
}

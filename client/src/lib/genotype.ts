/** Readable zygosity. The genotype is trusted unless the read share contradicts it. */
export function zygosityLabel(
  genotype: string | null | undefined,
  readDepth?: number | null,
  alternateDepth?: number | null
): {
  label: string;
  title: string;
} {
  const gt = genotype?.trim() ?? "";
  if (!gt) return { label: "—", title: "" };
  const alleles = gt.split(/[|/]/).filter(Boolean);
  const percent = alternateAllelePercent(readDepth, alternateDepth);
  const called = genotypeCall(gt, alleles);
  if (percent != null && percent >= 10 && percent < 30) {
    return {
      label: "Possible mosaic",
      title: `Genotype ${gt} (${called.label}) does not match the reads. ${Math.round(percent)}% of reads are alternate. A heterozygous site is usually near 50%, so this lower share is reviewed for mosaicism. A repeat or few supporting reads can look the same.`,
    };
  }
  if (percent != null && called.label === "Homozygous" && percent >= 30 && percent < 70) {
    return {
      label: "Heterozygous",
      title: `Genotype ${gt} says both alleles are alternate, but ${Math.round(percent)}% of reads are alternate, which is the heterozygous range.`,
    };
  }
  return called;
}

function genotypeCall(gt: string, alleles: string[]): { label: string; title: string } {
  if (alleles.length < 2) {
    if (alleles[0] === "0") {
      return { label: "Hemizygous ref", title: `Genotype ${gt}. One reference allele.` };
    }
    return { label: "Hemizygous", title: `Genotype ${gt}. One alternate allele.` };
  }
  if (new Set(alleles).size === 1) {
    if (alleles[0] === "0") {
      return { label: "Homozygous ref", title: `Genotype ${gt}. Both alleles match the reference.` };
    }
    return { label: "Homozygous", title: `Genotype ${gt}. Both alleles are the alternate.` };
  }
  return {
    label: "Heterozygous",
    title: `Genotype ${gt}. One reference allele and one alternate allele.`,
  };
}

/** Alternate reads as a percent of total depth. Heterozygous sites are usually near 50%. */
export function alternateAllelePercent(
  readDepth: number | null | undefined,
  alternateDepth: number | null | undefined
): number | null {
  if (readDepth == null || alternateDepth == null || readDepth <= 0) return null;
  return (alternateDepth / readDepth) * 100;
}

function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * Reference reads over alternate reads, plus the alternate share of total depth.
 * The reference count is the VCF AD reference allele when that field was stored.
 * Total depth minus the alternate count is only a fallback for rows parsed
 * before AD was kept, because unassigned reads make that sum larger than AD.
 */
export function alleleDepthLabel(
  readDepth: number | null | undefined,
  alternateDepth: number | null | undefined,
  referenceDepth?: number | null
): { text: string; percent: string | null; title: string } {
  const percent = alternateAllelePercent(readDepth, alternateDepth);
  const percentLabel = percent == null ? null : formatPercent(percent);
  const share =
    percentLabel == null
      ? ""
      : ` ${percentLabel} of reads carry the alternate allele. A heterozygous site is usually near 50%, and a homozygous site near 100%. A much lower percentage, with enough reads, is the pattern to review for mosaicism.`;
  if (referenceDepth != null && alternateDepth != null && referenceDepth >= 0) {
    const unassigned =
      readDepth != null && readDepth > referenceDepth + alternateDepth
        ? ` ${readDepth - referenceDepth - alternateDepth} reads are not assigned to either allele.`
        : "";
    const total = readDepth != null ? `, ${readDepth} total` : "";
    return {
      text: `${referenceDepth} / ${alternateDepth}`,
      percent: percentLabel,
      title: `${referenceDepth} reference reads, ${alternateDepth} alternate reads${total}.${unassigned}${share}`,
    };
  }
  if (readDepth == null && alternateDepth == null) return { text: "—", percent: null, title: "" };
  if (readDepth != null && alternateDepth != null && readDepth >= alternateDepth) {
    const reference = readDepth - alternateDepth;
    return {
      text: `${reference} / ${alternateDepth}`,
      percent: percentLabel,
      title: `${reference} reference reads, ${alternateDepth} alternate reads, ${readDepth} total.${share}`,
    };
  }
  return {
    text: `${readDepth ?? "—"} / ${alternateDepth ?? "—"}`,
    percent: percentLabel,
    title: percentLabel
      ? `Total reads / alternate reads. ${percentLabel} alternate.`
      : "Total reads / alternate reads",
  };
}

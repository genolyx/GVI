export type CarrierBanner = {
  total: number;
  pathogenic: number;
  vus: number;
  benign: number;
  geneCount: number;
  genes: string[];
  tone: "detected" | "uncertain" | "negative";
  title: string;
  detail: string;
};

const PLP = new Set(["pathogenic", "likely pathogenic"]);

export function carrierReviewBanner(
  rows: { gene: string | null; classification: string | null }[]
): CarrierBanner {
  const pathogenic = rows.filter(row =>
    PLP.has((row.classification || "").toLowerCase())
  );
  const vus = rows.filter(
    row => (row.classification || "").toLowerCase() === "vus"
  );
  const benign = rows.filter(row => {
    const value = (row.classification || "").toLowerCase();
    return value === "benign" || value === "likely benign";
  });
  const genes = Array.from(
    new Set(
      pathogenic
        .map(row => (row.gene || "").trim().toUpperCase())
        .filter(Boolean)
    )
  ).sort();
  const total = rows.length;
  if (pathogenic.length > 0) {
    return {
      total,
      pathogenic: pathogenic.length,
      vus: vus.length,
      benign: benign.length,
      geneCount: genes.length,
      genes,
      tone: "detected",
      title: `${pathogenic.length} pathogenic / likely pathogenic variants found`,
      detail: `${total.toLocaleString()} variants analysed, ${vus.length} VUS${genes.length ? `. Genes: ${genes.join(", ")}` : ""}`,
    };
  }
  if (vus.length > 0) {
    return {
      total,
      pathogenic: 0,
      vus: vus.length,
      benign: benign.length,
      geneCount: 0,
      genes: [],
      tone: "uncertain",
      title: `Uncertain — ${vus.length} VUS`,
      detail: `${total.toLocaleString()} variants analysed. No pathogenic variants in the classified set.`,
    };
  }
  return {
    total,
    pathogenic: 0,
    vus: 0,
    benign: benign.length,
    geneCount: 0,
    genes: [],
    tone: "negative",
    title: "Negative — no pathogenic variants detected",
    detail: `${total.toLocaleString()} variants analysed.`,
  };
}

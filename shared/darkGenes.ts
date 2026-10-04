import { z } from "zod";

/**
 * Clinical dark-gene sections for a carrier partner job.
 * Input is the pipeline detailed/summary report. GVC assigns section
 * severity. Reviewer approvals stay in the portal.
 */

export const partnerDarkGeneSectionSchema = z
  .object({
    title: z.string().min(1).max(160),
    body: z.string().max(20_000),
    kind: z.enum(["alert", "warning", "normal"]),
  })
  .strict();

export const partnerDarkGenesSchema = z
  .object({
    status: z.enum(["ready", "absent", "deferred"]),
    detailed_sections: z.array(partnerDarkGeneSectionSchema),
    cftr_ivs9_eh: z
      .object({
        source: z.literal("expansion_hunter_ivs9"),
        poly_t_rep_cn: z.array(z.number().int()).nullable(),
        tg_rep_cn: z.array(z.number().int()).nullable(),
        raw_poly_t: z.string().nullable(),
        raw_tg: z.string().nullable(),
        display_t: z.string().nullable(),
        display_tg: z.string().nullable(),
        risk_level: z.enum(["low", "high"]),
        risk_reasons: z.array(z.string()),
        per_allele_summary: z.string().nullable(),
        locus_note: z.string().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type PartnerDarkGenes = z.infer<typeof partnerDarkGenesSchema>;

export const partnerDarkGeneInputSchema = z
  .object({
    summaryText: z.string().max(400_000).default(""),
    detailedText: z.string().max(800_000).default(""),
  })
  .strict();

export function interpretDarkGenes(input: {
  summaryText?: string;
  detailedText?: string;
}): PartnerDarkGenes {
  const summaryText = input.summaryText ?? "";
  const detailedText = input.detailedText ?? "";
  const source = detailedText.trim() || summaryText.trim();
  if (!source) {
    return { status: "absent", detailed_sections: [], cftr_ivs9_eh: null };
  }
  const combined = `${summaryText}\n${detailedText}`;
  const cftr = parseCftrExpansionHunter(combined);
  const sections = parseDetailedReport(source).map(section => ({
    ...section,
    kind: elevateKind(section.kind, section.body, cftr),
  }));
  const parsed = partnerDarkGenesSchema.safeParse({
    status: "ready",
    detailed_sections: sections,
    cftr_ivs9_eh: cftr,
  });
  if (!parsed.success) {
    return { status: "absent", detailed_sections: [], cftr_ivs9_eh: null };
  }
  return parsed.data;
}

function parseDetailedReport(
  text: string
): Array<{ title: string; body: string; kind: "alert" | "warning" | "normal" }> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const sections: Array<{
    title: string;
    body: string;
    kind: "alert" | "warning" | "normal";
  }> = [];
  let title = "Overview";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim().slice(0, 20_000);
    buf = [];
    if (!body) return;
    sections.push({ title: title.trim().slice(0, 160), body, kind: titleKind(title) });
  };

  for (const line of lines) {
    if (isRule(line)) continue;
    if (isSectionHeader(line)) {
      flush();
      const stripped = line.trim();
      title = isBanner(stripped)
        ? stripped.replace(/^!+\s*/, "").replace(/\s*!+$/, "").trim()
        : stripped.replace(/:$/, "").trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

function isRule(line: string): boolean {
  const stripped = line.trim();
  return stripped.length > 0 && /^[=\-]+$/.test(stripped);
}

function isBanner(line: string): boolean {
  const stripped = line.trim();
  return (
    stripped.startsWith("!!!") && stripped.endsWith("!!!") && stripped.length < 160
  );
}

function isSectionHeader(line: string): boolean {
  const stripped = line.trim();
  if (!stripped || stripped.length > 130) return false;
  if (isBanner(stripped)) return true;
  if (line.startsWith("  ") || line.startsWith("\t")) return false;
  if (!stripped.endsWith(":")) return false;
  if (/^[A-Za-z0-9_]+\s*:\s*\S/.test(stripped)) return false;
  return true;
}

function titleKind(title: string): "alert" | "warning" | "normal" {
  const upper = title.toUpperCase();
  if (upper.includes("QUALITY") && upper.includes("WARNING")) return "alert";
  if (upper.includes("WARNING")) return "warning";
  return "normal";
}

function elevateKind(
  kind: "alert" | "warning" | "normal",
  body: string,
  cftr: PartnerDarkGenes["cftr_ivs9_eh"]
): "alert" | "warning" | "normal" {
  let next = kind;
  if (next === "normal" && /\bWARNING\s*:/i.test(body)) next = "warning";

  const smnCounts: number[] = [];
  const smnPattern = /\bSMN1(?:_CN(?:_est)?)?\s*=\s*(\d+)/gi;
  let smnMatch: RegExpExecArray | null;
  while ((smnMatch = smnPattern.exec(body)) !== null) {
    smnCounts.push(Number(smnMatch[1]));
  }
  if (smnCounts.some(count => count === 0)) next = "alert";
  else if (smnCounts.some(count => count === 1) && next === "normal") next = "warning";
  if (next === "normal" && /SilentCarrier\s*=\s*True\b/i.test(body)) next = "warning";

  const fragile = body.match(/\bFMR1\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  if (fragile) {
    const repeats = Math.max(Number(fragile[1]), Number(fragile[2]));
    if (repeats >= 200) next = "alert";
    else if (repeats >= 55 && next !== "alert") next = "warning";
  }

  if (
    next === "normal" &&
    cftr?.risk_level === "high" &&
    /CFTR_(?:polyT|TG)\s*=/i.test(body)
  ) {
    next = "warning";
  }
  return next;
}

function parseCftrExpansionHunter(
  text: string
): PartnerDarkGenes["cftr_ivs9_eh"] {
  const polyT =
    text.match(/\bCFTR_polyT\s*=\s*(\d+)\s*\/\s*(\d+)/i) ??
    text.match(/\bCFTR\s+poly[-_\s]*T\s*=\s*(\d+)\s*\/\s*(\d+)/i);
  const tg =
    text.match(/\bCFTR_TG\s*=\s*(\d+)\s*\/\s*(\d+)/i) ??
    text.match(/\bCFTR\s+_?\s*TG\s*=\s*(\d+)\s*\/\s*(\d+)/i);
  if (!polyT && !tg) return null;

  const tAlleles = polyT ? [Number(polyT[1]), Number(polyT[2])] : [];
  const tgAlleles = tg ? [Number(tg[1]), Number(tg[2])] : [];
  const reasons: string[] = [];
  for (const allele of tAlleles) {
    if (allele === 5) {
      reasons.push("5T allele (elevated CFTR-RD/CBAVD context per Cuppens/Groman)");
    }
  }
  for (const allele of tgAlleles) {
    if (allele >= 13) reasons.push(`TG repeat ×${allele} (high-penetrance context)`);
    else if (allele === 12) {
      reasons.push(`TG repeat ×${allele} (low–moderate penetrance; flagged for review)`);
    }
  }
  const perAllele = text.match(/^\s*Per-allele\s*:\s*(.+)$/im);
  const result: PartnerDarkGenes["cftr_ivs9_eh"] = {
    source: "expansion_hunter_ivs9",
    poly_t_rep_cn: polyT ? tAlleles : null,
    tg_rep_cn: tg ? tgAlleles : null,
    raw_poly_t: polyT ? `${tAlleles[0]}/${tAlleles[1]}` : null,
    raw_tg: tg ? `${tgAlleles[0]}/${tgAlleles[1]}` : null,
    display_t: polyT ? `${tAlleles[0]}T/${tAlleles[1]}T` : null,
    display_tg: tg ? `TG${tgAlleles[0]}/TG${tgAlleles[1]}` : null,
    risk_level: reasons.length ? "high" : "low",
    risk_reasons: reasons,
    per_allele_summary: perAllele ? perAllele[1].trim().slice(0, 2000) : null,
  };
  if (/117\s*,\s*548\s*,\s*607|117548607/.test(text)) {
    result.locus_note = "Locus chr7:117,548,607-117,548,635 (GRCh38); ref (TG)11(T)7";
  }
  return result;
}

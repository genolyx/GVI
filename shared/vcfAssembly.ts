export type ReferenceBuild = "GRCh37" | "GRCh38";

export type DetectedReferenceBuild = {
  build: ReferenceBuild;
  /** Common name used on the file: hg38 for GRCh38, hg19 for GRCh37. */
  commonName: "hg38" | "hg19";
  source: "contig-length" | "header";
};

const LENGTHS: Record<string, { grch38: number; grch37: number }> = {
  "1": { grch38: 248956422, grch37: 249250621 },
  "2": { grch38: 242193529, grch37: 243199373 },
  "3": { grch38: 198295559, grch37: 198022430 },
  "4": { grch38: 190214555, grch37: 191154276 },
  "5": { grch38: 181538259, grch37: 180915260 },
  "6": { grch38: 170805979, grch37: 171115067 },
  "7": { grch38: 159345973, grch37: 159138663 },
  "8": { grch38: 145138636, grch37: 146364022 },
  "9": { grch38: 138394717, grch37: 141213431 },
  "10": { grch38: 133797422, grch37: 135534747 },
  "11": { grch38: 135086622, grch37: 135006516 },
  "12": { grch38: 133275309, grch37: 133851895 },
  "13": { grch38: 114364328, grch37: 115169878 },
  "14": { grch38: 107043718, grch37: 107349540 },
  "15": { grch38: 101991189, grch37: 102531392 },
  "16": { grch38: 90338345, grch37: 90354753 },
  "17": { grch38: 83257441, grch37: 81195210 },
  "18": { grch38: 80373285, grch37: 78077248 },
  "19": { grch38: 58617616, grch37: 59128983 },
  "20": { grch38: 64444167, grch37: 63025520 },
  "21": { grch38: 46709983, grch37: 48129895 },
  "22": { grch38: 50818468, grch37: 51304566 },
  X: { grch38: 156040895, grch37: 155270560 },
  Y: { grch38: 57227415, grch37: 59373566 },
};

const HG38 = /\b(?:GRCh38|hg38|assembly38)\b/i;
const HG19 = /\b(?:GRCh37|hg19|hg37|hs37d5|assembly19)\b|\bb37\b/i;

function contigAttributes(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of body.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    attributes[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return attributes;
}

function namedBuild(value: string): ReferenceBuild | "both" | null {
  const hg38 = HG38.test(value);
  const hg19 = HG19.test(value);
  if (hg38 && hg19) return "both";
  if (hg38) return "GRCh38";
  if (hg19) return "GRCh37";
  return null;
}

function headerBuild(header: string): ReferenceBuild | null {
  const votes = new Set<ReferenceBuild>();
  for (const line of header.split(/\r?\n/)) {
    if (line.startsWith("##reference=") || line.startsWith("##assembly=")) {
      const named = namedBuild(line.slice(line.indexOf("=") + 1));
      if (named && named !== "both") votes.add(named);
    } else if (line.startsWith("##contig=<")) {
      const assembly = contigAttributes(line.slice("##contig=<".length).replace(/>$/, "")).assembly;
      if (!assembly) continue;
      const named = namedBuild(assembly);
      if (named && named !== "both") votes.add(named);
    }
  }
  if (votes.size !== 1) return null;
  return Array.from(votes)[0];
}

function lengthBuild(header: string): ReferenceBuild | null {
  let grch38 = 0;
  let grch37 = 0;
  for (const line of header.split(/\r?\n/)) {
    if (!line.startsWith("##contig=<")) continue;
    const attributes = contigAttributes(
      line.slice("##contig=<".length).replace(/>$/, "")
    );
    const id = (attributes.ID || "").replace(/^chr/i, "").toUpperCase();
    const length = Number(attributes.length);
    const known = LENGTHS[id];
    if (!known || !Number.isInteger(length)) continue;
    if (length === known.grch38) grch38 += 1;
    else if (length === known.grch37) grch37 += 1;
  }
  if (grch38 > 0 && grch37 === 0) return "GRCh38";
  if (grch37 > 0 && grch38 === 0) return "GRCh37";
  return null;
}

/** Read hg38 / hg19 from a VCF header. Contig lengths win over a reference filename. */
export function detectReferenceBuild(header: string): DetectedReferenceBuild | null {
  const fromLength = lengthBuild(header);
  const fromHeader = headerBuild(header);
  const build = fromLength ?? fromHeader;
  if (!build) return null;
  return {
    build,
    commonName: build === "GRCh38" ? "hg38" : "hg19",
    source: fromLength ? "contig-length" : "header",
  };
}

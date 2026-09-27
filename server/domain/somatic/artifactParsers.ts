import { createHash } from "node:crypto";

const MAX_ARTIFACT_BYTES = 20_000_000;
const MAX_RECORDS = 10_000;

export type ParsedPanelRegion = {
  regionKey: string;
  regionType: "interval";
  findingType: null;
  gene: null;
  transcript: null;
  chromosome: string;
  start: number;
  end: number;
  target: {
    sourceFormat: "BED";
    sourceCoordinates: "0-based-half-open";
  };
  minimumDepth: number | null;
  minimumCoveragePercent: number | null;
  reportable: boolean;
};

export type ParsedCoverageRecord = {
  regionKey: string;
  meanDepth: number | null;
  coveredPercent: number | null;
};

export class SomaticArtifactParseError extends Error {
  constructor(
    message: string,
    readonly line?: number
  ) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "SomaticArtifactParseError";
  }
}

export function sha256TextArtifact(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertArtifactSize(text: string) {
  if (!text.trim()) throw new SomaticArtifactParseError("Artifact is empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new SomaticArtifactParseError(
      `Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`
    );
  }
}

function finiteNumber(
  value: string,
  label: string,
  line: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SomaticArtifactParseError(`${label} must be numeric.`, line);
  }
  return parsed;
}

/**
 * Parse strict BED4 reportable regions.
 *
 * BED coordinates are converted from 0-based half-open to the platform's
 * 1-based inclusive coordinates. Column 4 (regionKey) is mandatory so coverage
 * artifacts can be joined deterministically without coordinate heuristics.
 */
export function parseBedReportableRegions(
  text: string,
  options: {
    minimumDepth: number | null;
    minimumCoveragePercent: number | null;
    reportable?: boolean;
  }
): ParsedPanelRegion[] {
  assertArtifactSize(text);
  if (
    options.minimumDepth != null &&
    (!Number.isInteger(options.minimumDepth) || options.minimumDepth < 0)
  ) {
    throw new SomaticArtifactParseError(
      "Default minimum depth must be a non-negative integer."
    );
  }
  if (
    options.minimumCoveragePercent != null &&
    (options.minimumCoveragePercent < 0 ||
      options.minimumCoveragePercent > 100)
  ) {
    throw new SomaticArtifactParseError(
      "Default minimum coverage percent must be between 0 and 100."
    );
  }

  const records: ParsedPanelRegion[] = [];
  const keys = new Set<string>();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("track ") ||
      line.startsWith("browser ")
    ) {
      return;
    }
    const columns = rawLine.split("\t");
    if (columns.length < 4) {
      throw new SomaticArtifactParseError(
        "Clinical BED import requires chromosome, start, end, and a unique regionKey.",
        lineNumber
      );
    }
    const chromosome = columns[0].trim().replace(/^chr/i, "");
    const startZeroBased = finiteNumber(columns[1], "BED start", lineNumber);
    const endExclusive = finiteNumber(columns[2], "BED end", lineNumber);
    const regionKey = columns[3].trim();
    if (
      !chromosome ||
      !Number.isInteger(startZeroBased) ||
      !Number.isInteger(endExclusive) ||
      startZeroBased < 0 ||
      endExclusive <= startZeroBased
    ) {
      throw new SomaticArtifactParseError(
        "BED coordinates must be ordered non-negative integers.",
        lineNumber
      );
    }
    if (!regionKey) {
      throw new SomaticArtifactParseError(
        "BED column 4 regionKey is required.",
        lineNumber
      );
    }
    if (keys.has(regionKey)) {
      throw new SomaticArtifactParseError(
        `Duplicate regionKey "${regionKey}".`,
        lineNumber
      );
    }
    keys.add(regionKey);
    records.push({
      regionKey,
      regionType: "interval",
      findingType: null,
      gene: null,
      transcript: null,
      chromosome,
      start: startZeroBased + 1,
      end: endExclusive,
      target: {
        sourceFormat: "BED",
        sourceCoordinates: "0-based-half-open",
      },
      minimumDepth: options.minimumDepth,
      minimumCoveragePercent: options.minimumCoveragePercent,
      reportable: options.reportable ?? true,
    });
    if (records.length > MAX_RECORDS) {
      throw new SomaticArtifactParseError(
        `Artifact exceeds ${MAX_RECORDS} records.`
      );
    }
  });
  if (!records.length) {
    throw new SomaticArtifactParseError(
      "No BED records were found after comments and directives were removed."
    );
  }
  return records;
}

export function parseCoverageArtifact(text: string): ParsedCoverageRecord[] {
  assertArtifactSize(text);
  const trimmed = text.trim();
  const rawRecords: Array<Record<string, unknown>> = trimmed.startsWith("[")
    ? parseCoverageJson(trimmed)
    : parseCoverageTsv(trimmed);
  if (rawRecords.length > MAX_RECORDS) {
    throw new SomaticArtifactParseError(
      `Artifact exceeds ${MAX_RECORDS} records.`
    );
  }
  const keys = new Set<string>();
  return rawRecords.map((record, index) => {
    const line = index + 2;
    const regionKey =
      typeof record.regionKey === "string" ? record.regionKey.trim() : "";
    if (!regionKey) {
      throw new SomaticArtifactParseError("regionKey is required.", line);
    }
    if (keys.has(regionKey)) {
      throw new SomaticArtifactParseError(
        `Duplicate regionKey "${regionKey}".`,
        line
      );
    }
    keys.add(regionKey);
    return {
      regionKey,
      meanDepth: nullableMetric(record.meanDepth, "meanDepth", line),
      coveredPercent: nullableMetric(
        record.coveredPercent,
        "coveredPercent",
        line,
        100
      ),
    };
  });
}

function parseCoverageJson(text: string): Array<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SomaticArtifactParseError("Coverage JSON is invalid.");
  }
  if (!Array.isArray(value) || !value.length) {
    throw new SomaticArtifactParseError(
      "Coverage JSON must be a non-empty array."
    );
  }
  return value as Array<Record<string, unknown>>;
}

function parseCoverageTsv(text: string): Array<Record<string, unknown>> {
  const lines = text
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith("#"));
  const header = lines[0]?.split("\t").map(value => value.trim());
  if (
    !header ||
    header[0] !== "regionKey" ||
    header[1] !== "meanDepth" ||
    header[2] !== "coveredPercent"
  ) {
    throw new SomaticArtifactParseError(
      "Coverage TSV header must be regionKey, meanDepth, coveredPercent."
    );
  }
  if (lines.length < 2) {
    throw new SomaticArtifactParseError("Coverage TSV has no data records.");
  }
  return lines.slice(1).map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== 3) {
      throw new SomaticArtifactParseError(
        "Coverage TSV records require exactly three columns.",
        index + 2
      );
    }
    return {
      regionKey: columns[0],
      meanDepth: columns[1] === "" ? null : columns[1],
      coveredPercent: columns[2] === "" ? null : columns[2],
    };
  });
}

function nullableMetric(
  value: unknown,
  label: string,
  line: number,
  maximum?: number
): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (maximum != null && parsed > maximum)
  ) {
    throw new SomaticArtifactParseError(
      `${label} must be a non-negative number${maximum == null ? "" : ` not greater than ${maximum}`}.`,
      line
    );
  }
  return parsed;
}

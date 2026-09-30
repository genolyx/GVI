import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ENV } from "../_core/env";
import { inspectVcfAnnotation } from "./vcfAnnotation";

export class VcfAnnotationFailure extends Error {
  readonly lines: string[];

  constructor(message: string, lines: string[]) {
    super(message);
    this.lines = lines;
  }
}

export type AnnotationCommand = {
  command: string;
  args: string[];
};

export type AnnotationConfig = {
  scriptPath: string;
  dataDir: string;
};

function annotationConfig(): AnnotationConfig {
  return {
    scriptPath: ENV.gxExomeAnnotateScript,
    dataDir: ENV.gxExomeDataDir,
  };
}

/** gx-exome/src/annotate_vcf.sh --vcf --assembly --out --data-dir */
export function buildAnnotationCommand(
  config: AnnotationConfig,
  input: {
    assembly: "GRCh37" | "GRCh38";
    inputPath: string;
    outputPath: string;
  }
): AnnotationCommand {
  const missing: string[] = [];
  if (!config.scriptPath) missing.push("GX_EXOME_ANNOTATE_SCRIPT");
  if (!config.dataDir) missing.push("GX_EXOME_DATA_DIR");
  if (missing.length) {
    throw new VcfAnnotationFailure(
      `This VCF has no annotation, and gx-exome annotate_vcf.sh is not configured (${missing.join(", ")}).`,
      missing.map(name => `${name} is required before a raw VCF can be annotated.`)
    );
  }
  return {
    command: config.scriptPath,
    args: [
      "--vcf",
      input.inputPath,
      "--assembly",
      input.assembly,
      "--out",
      input.outputPath,
      "--data-dir",
      config.dataDir,
    ],
  };
}

function runCommand(command: AnnotationCommand, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", chunk => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", error => {
      if (error.name === "AbortError") {
        reject(new VcfAnnotationFailure("Annotation stopped.", ["Stopped by user."]));
        return;
      }
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(
        new VcfAnnotationFailure(
          missing
            ? `Annotation command was not found: ${command.command}`
            : error.message,
          missing
            ? [`${command.command} is not on PATH.`]
            : [error.message]
        )
      );
    });
    child.on("close", code => {
      if (signal.aborted) {
        reject(new VcfAnnotationFailure("Annotation stopped.", ["Stopped by user."]));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-4000);
      reject(
        new VcfAnnotationFailure(
          `VEP annotation failed (exit ${code ?? "unknown"}).`,
          [detail || `Command exited ${code}.`]
        )
      );
    });
  });
}

export function annotatedVcfFileName(sourceFileName: string) {
  const stem = sourceFileName.replace(/\.vcf(\.gz)?$/i, "").replace(/[/\\]/g, "_");
  return `${stem || "sample"}.annotated.vcf.gz`;
}

/**
 * Skip annotation when the VCF already has CSQ or ANN and the required columns.
 * Otherwise run VEP and return the annotated text plus the gzip bytes to store.
 */
export async function ensureAnnotatedVcf(input: {
  text: string;
  referenceBuild: "GRCh37" | "GRCh38";
  shouldStop: () => boolean;
  onEvent: (message: string, progress: number) => Promise<void>;
}) {
  const inspection = inspectVcfAnnotation(input.text);
  if (inspection.action === "reject") {
    throw new VcfAnnotationFailure(
      `This VCF is already annotated with ${inspection.source === "vep" ? "VEP" : "snpEff"}, but required columns are missing: ${inspection.missing.join(", ")}.`,
      inspection.missing.map(column => `Missing column: ${column}`)
    );
  }
  if (inspection.action === "skip") {
    const tool = inspection.source === "vep" ? "VEP CSQ" : "snpEff ANN";
    await input.onEvent(
      `Annotation skipped. This VCF already has ${tool}. Required columns: ${inspection.columns.join(", ")}.`,
      30
    );
    return { text: input.text, gzip: null as Buffer | null };
  }
  if (input.shouldStop()) {
    throw new VcfAnnotationFailure("Annotation stopped.", ["Stopped by user."]);
  }

  await input.onEvent(
    "Annotation queued. This VCF has no CSQ or ANN, so VEP will add gene, consequence, and gnomAD AF.",
    15
  );
  const config = annotationConfig();
  const workDir = await mkdtemp(join(tmpdir(), "gvi-vep-"));
  const controller = new AbortController();
  const stopWatch = setInterval(() => {
    if (input.shouldStop()) controller.abort();
  }, 1000);
  try {
    const inputPath = join(workDir, "input.vcf");
    const outputPath = join(workDir, "annotated.vcf.gz");
    const command = buildAnnotationCommand(config, {
      assembly: input.referenceBuild,
      inputPath,
      outputPath,
    });
    await writeFile(inputPath, input.text);
    await runCommand(command, controller.signal);
    const gzip = await readFile(outputPath);
    const annotated = gzip.length
      ? gunzipSync(gzip).toString("utf8")
      : "";
    if (!annotated) throw new VcfAnnotationFailure("VEP wrote an empty VCF.", []);
    const produced = inspectVcfAnnotation(annotated);
    if (produced.action !== "skip") {
      const missing = produced.action === "reject" ? produced.missing.join(", ") : "CSQ";
      throw new VcfAnnotationFailure(
        `VEP finished, but the output is missing required columns: ${missing}.`,
        [`Missing column: ${missing}`]
      );
    }
    await input.onEvent(
      `VEP annotation finished. Required columns: ${produced.columns.join(", ")}.`,
      60
    );
    return { text: annotated, gzip };
  } finally {
    clearInterval(stopWatch);
    await rm(workDir, { recursive: true, force: true });
  }
}

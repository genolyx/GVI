import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { somaticInterpretationRuns } from "../../../drizzle/schema";
import { writeAuditEvent } from "../audit";
import { requireDb } from "../tenant";
import { createOrganizationSomaticEvidenceProvider } from "./offlineKnowledge";
import {
  addSomaticRunEvent,
  loadSomaticCase,
  SOMATIC_PIPELINE_VERSION,
  SOMATIC_RUN_RULESET_VERSION,
} from "./runProcessor";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "validating",
  "normalizing",
  "annotating",
] as const;

export async function enqueueSomaticInterpretationRun(input: {
  organizationId: number;
  caseId: number;
  requestedBy: number;
  req?: Request;
  trigger?: "manual" | "reinterpretation";
  reinterpretationTaskId?: number;
}): Promise<{ runId: number; deduplicated: boolean }> {
  const record = await loadSomaticCase(input.organizationId, input.caseId);
  const db = await requireDb();
  const active = await db
    .select({ id: somaticInterpretationRuns.id })
    .from(somaticInterpretationRuns)
    .where(
      and(
        eq(somaticInterpretationRuns.organizationId, input.organizationId),
        eq(somaticInterpretationRuns.caseId, input.caseId),
        inArray(somaticInterpretationRuns.status, ACTIVE_RUN_STATUSES)
      )
    )
    .limit(1);
  if (active[0]) {
    return { runId: active[0].id, deduplicated: true };
  }

  const evidenceProvider = await createOrganizationSomaticEvidenceProvider(
    input.organizationId
  );
  const inserted = await db
    .insert(somaticInterpretationRuns)
    .values({
      organizationId: input.organizationId,
      caseId: input.caseId,
      contextId: record.context.id,
      status: "queued",
      pipelineVersion: SOMATIC_PIPELINE_VERSION,
      rulesetVersion: SOMATIC_RUN_RULESET_VERSION,
      knowledgeVersions: { ...evidenceProvider.knowledgeVersions },
      maxAttempts: Math.min(
        10,
        Math.max(
          1,
          Math.floor(Number(process.env.SOMATIC_WORKER_MAX_ATTEMPTS) || 3)
        )
      ),
      requestedBy: input.requestedBy,
    })
    .onConflictDoNothing()
    .returning({ id: somaticInterpretationRuns.id });

  if (!inserted[0]) {
    const concurrent = await db
      .select({ id: somaticInterpretationRuns.id })
      .from(somaticInterpretationRuns)
      .where(
        and(
          eq(somaticInterpretationRuns.organizationId, input.organizationId),
          eq(somaticInterpretationRuns.caseId, input.caseId),
          inArray(somaticInterpretationRuns.status, ACTIVE_RUN_STATUSES)
        )
      )
      .limit(1);
    if (!concurrent[0]) {
      throw new Error("Somatic interpretation run could not be queued.");
    }
    return { runId: concurrent[0].id, deduplicated: true };
  }

  const runId = inserted[0].id;
  const trigger = input.trigger ?? "manual";
  await addSomaticRunEvent(
    input.organizationId,
    runId,
    "queued",
    trigger === "reinterpretation"
      ? "Somatic reinterpretation queued."
      : "Somatic interpretation queued.",
    0,
    {
      trigger,
      reinterpretationTaskId: input.reinterpretationTaskId ?? null,
    }
  );
  await writeAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.requestedBy,
    action:
      trigger === "reinterpretation"
        ? "somatic.reinterpretation_run.started"
        : "somatic.interpretation.started",
    entityType: "somatic_interpretation_run",
    entityId: runId,
    after: {
      caseId: input.caseId,
      pipelineVersion: SOMATIC_PIPELINE_VERSION,
      rulesetVersion: SOMATIC_RUN_RULESET_VERSION,
      trigger,
      reinterpretationTaskId: input.reinterpretationTaskId ?? null,
    },
    req: input.req,
  });
  return { runId, deduplicated: false };
}

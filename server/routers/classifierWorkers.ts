import { inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { curationRuns } from "../../drizzle/schema";
import { router, superAdminProcedure } from "../_core/trpc";
import {
  CLASSIFIER_WORKER_MAX,
  CLASSIFIER_WORKER_MIN,
  ensureClassifierWorkers,
  listClassifierWorkerProcesses,
  writeClassifierWorkerCount,
} from "../domain/curationWorker";
import { requireDb } from "../domain/tenant";

export const classifierWorkersRouter = router({
  status: superAdminProcedure
    .input(z.object({ organizationId: z.number().int().positive().optional() }))
    .query(({ input }) => workerStatus(input.organizationId ?? null)),
  setCount: superAdminProcedure
    .input(z.object({ count: z.number().int().min(CLASSIFIER_WORKER_MIN).max(CLASSIFIER_WORKER_MAX) }))
    .mutation(async ({ input }) => {
      writeClassifierWorkerCount(input.count);
      try {
        ensureClassifierWorkers();
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "The classifier workers did not start.",
        });
      }
      return workerStatus(null);
    }),
});

async function workerStatus(organizationId: number | null) {
  const processes = await listClassifierWorkerProcesses();
  const db = await requireDb();
  const active = await db
    .select({
      workerId: curationRuns.workerId,
      status: curationRuns.status,
      organizationId: curationRuns.organizationId,
      caseId: curationRuns.caseId,
      input: curationRuns.input,
    })
    .from(curationRuns)
    .where(inArray(curationRuns.status, ["loading", "running"]));
  const byWorker = new Map(active.filter(row => row.workerId).map(row => [row.workerId as string, row]));
  return {
    min: CLASSIFIER_WORKER_MIN,
    max: CLASSIFIER_WORKER_MAX,
    desired: processes.desired,
    workers: processes.workers.map(worker => {
      const run = byWorker.get(worker.name);
      const sameOrganization = organizationId == null || run?.organizationId === organizationId;
      const label = run && sameOrganization ? [run.input.gene, run.input.hgvsC].filter(Boolean).join(" ") : null;
      const state =
        worker.process === "stopping"
          ? "stopping"
          : run?.status === "running"
            ? "running"
            : run?.status === "loading" || worker.process === "loading"
              ? "loading"
              : worker.process === "ready"
                ? "idle"
                : worker.process;
      return {
        name: worker.name,
        index: worker.index,
        state,
        variant: label,
        hidden: Boolean(run && !sameOrganization),
        caseId: run && sameOrganization ? run.caseId : null,
      };
    }),
  };
}

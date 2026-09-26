import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { inspectReferenceData, setClinvarSource, setGnomadSource } from "../domain/referenceData";

export const referenceDataRouter = router({
  status: adminProcedure.query(() => inspectReferenceData()),
  setGnomadSource: adminProcedure
    .input(z.object({ mode: z.enum(["myvariant", "v3.1.2", "v4.1"]) }))
    .mutation(async ({ input }) => {
      try {
        await setGnomadSource(input.mode);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not save the gnomAD source.",
        });
      }
      return inspectReferenceData();
    }),
  setClinvarSource: adminProcedure
    .input(z.object({ mode: z.enum(["local", "ncbi"]) }))
    .mutation(async ({ input }) => {
      try {
        await setClinvarSource(input.mode);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not save the ClinVar source.",
        });
      }
      return inspectReferenceData();
    }),
});

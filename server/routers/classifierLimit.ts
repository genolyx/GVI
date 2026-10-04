import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { classifierLimitStatus, saveClassifierCaseLimit } from "../domain/classifierLimit";

export const classifierLimitRouter = router({
  status: adminProcedure.query(() => classifierLimitStatus()),
  save: adminProcedure
    .input(z.object({ limit: z.number().int() }))
    .mutation(async ({ input }) => {
      try {
        await saveClassifierCaseLimit(input.limit);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not save the classifier limit.",
        });
      }
      return classifierLimitStatus();
    }),
});

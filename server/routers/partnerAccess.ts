import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import {
  generatePartnerToken,
  partnerTokenStatus,
  savePartnerToken,
} from "../domain/partnerToken";

export const partnerAccessRouter = router({
  status: adminProcedure.query(() => partnerTokenStatus()),
  generate: adminProcedure.mutation(async () => {
    const token = await generatePartnerToken();
    return { token, ...(await partnerTokenStatus()) };
  }),
  save: adminProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await savePartnerToken(input.token);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not save the partner token.",
        });
      }
      return partnerTokenStatus();
    }),
});

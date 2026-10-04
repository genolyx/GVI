import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import {
  checkPortalConnection,
  DEFAULT_PORTAL_URL,
  generatePartnerToken,
  partnerTokenStatus,
  readPortalUrl,
  savePartnerToken,
  savePortalUrl,
} from "../domain/partnerToken";

export const partnerAccessRouter = router({
  status: adminProcedure.query(async () => ({
    ...(await partnerTokenStatus()),
    portalUrl: (await readPortalUrl()) || DEFAULT_PORTAL_URL,
  })),
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
  savePortalUrl: adminProcedure
    .input(z.object({ url: z.string() }))
    .mutation(async ({ input }) => {
      try {
        await savePortalUrl(input.url);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not save the portal URL.",
        });
      }
      return { portalUrl: (await readPortalUrl()) || DEFAULT_PORTAL_URL };
    }),
  check: adminProcedure
    .input(z.object({ url: z.string().optional() }).optional())
    .mutation(async ({ input }) => checkPortalConnection(input?.url)),
});

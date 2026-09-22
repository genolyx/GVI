import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { organizationsRouter } from "./routers/organizations";
import { projectsRouter } from "./routers/projects";
import { casesRouter } from "./routers/cases";
import { variantsRouter } from "./routers/variants";
import { copilotRouter } from "./routers/copilot";
import { curationRouter } from "./routers/curation";
import { dashboardRouter } from "./routers/dashboard";
import { reportsRouter } from "./routers/reports";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  organizations: organizationsRouter,
  projects: projectsRouter,
  cases: casesRouter,
  variants: variantsRouter,
  copilot: copilotRouter,
  curation: curationRouter,
  dashboard: dashboardRouter,
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;

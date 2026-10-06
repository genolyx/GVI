import { eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { users } from "../drizzle/schema";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { requireDb } from "./domain/tenant";
import { organizationsRouter } from "./routers/organizations";
import { projectsRouter } from "./routers/projects";
import { casesRouter } from "./routers/cases";
import { germlinePanelsRouter } from "./routers/germlinePanels";
import { germlineReviewRouter } from "./routers/germlineReview";
import { variantsRouter } from "./routers/variants";
import { copilotRouter } from "./routers/copilot";
import { curationRouter } from "./routers/curation";
import { workbenchRouter } from "./routers/workbench";
import { dashboardRouter } from "./routers/dashboard";
import { reportsRouter } from "./routers/reports";
import { referenceDataRouter } from "./routers/referenceData";
import { partnerAccessRouter } from "./routers/partnerAccess";
import { classifierLimitRouter } from "./routers/classifierLimit";
import { classifiedVariantsRouter } from "./routers/classifiedVariants";
import { classifierWorkersRouter } from "./routers/classifierWorkers";
import { somaticRouter } from "./routers/somatic";
import { somaticReportsRouter } from "./routers/somaticReports";
import { somaticFoundationRouter } from "./routers/somaticFoundation";

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    acceptResearchUse: protectedProcedure.mutation(async ({ ctx }) => {
      const acceptedAt = new Date();
      const db = await requireDb();
      await db
        .update(users)
        .set({ researchUseAcceptedAt: acceptedAt })
        .where(eq(users.id, ctx.user.id));
      return { researchUseAcceptedAt: acceptedAt };
    }),
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
  germlinePanels: germlinePanelsRouter,
  germlineReview: germlineReviewRouter,
  variants: variantsRouter,
  copilot: copilotRouter,
  curation: curationRouter,
  workbench: workbenchRouter,
  dashboard: dashboardRouter,
  reports: reportsRouter,
  referenceData: referenceDataRouter,
  partnerAccess: partnerAccessRouter,
  classifierLimit: classifierLimitRouter,
  classifiedVariants: classifiedVariantsRouter,
  classifierWorkers: classifierWorkersRouter,
  somatic: somaticRouter,
  somaticReports: somaticReportsRouter,
  somaticFoundation: somaticFoundationRouter,
});

export type AppRouter = typeof appRouter;

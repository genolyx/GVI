import { z } from "zod";
import { CLASSIFICATION_FAST_SHORTS } from "../../shared/curation/classificationSearch";
import { adminProcedure, router } from "../_core/trpc";
import { searchClassifiedVariants } from "../domain/classifiedVariants";

export const classifiedVariantsRouter = router({
  search: adminProcedure
    .input(
      z.object({
        query: z.string().max(200).default(""),
        source: z.enum(["all", "portal", "gvc"]).default("all"),
        call: z.enum(CLASSIFICATION_FAST_SHORTS).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(({ input }) => searchClassifiedVariants(input)),
});

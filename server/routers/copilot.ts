import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  aiConversations,
  aiMessages,
  cases,
  evidenceItems,
  interpretations,
  variants,
} from "../../drizzle/schema";
import { invokeLLM, listLLMModels } from "../_core/llm";
import { protectedProcedure, router } from "../_core/trpc";
import { writeAuditEvent } from "../domain/audit";
import {
  citationsBelongToVariant,
  COPILOT_SYSTEM_PROMPT,
  uniqueCitationIds,
} from "../domain/copilotGuardrails";
import { requireDb, requireOrganizationPermission } from "../domain/tenant";

const copilotOutputSchema = z.object({
  answer: z.string().min(1),
  draftInterpretation: z.string(),
  citedEvidenceIds: z.array(z.number().int().positive()),
  uncitedClaims: z.array(z.string()),
  limitations: z.array(z.string()),
  suggestedNextSteps: z.array(z.string()),
});

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(part && typeof part === "object" && (part as any).type === "text")
      )
      .map(part => part.text)
      .join("\n");
  }
  return "";
}

async function requireVariantContext(organizationId: number, variantId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ variant: variants, clinicalCase: cases })
    .from(variants)
    .innerJoin(cases, and(eq(cases.id, variants.caseId), eq(cases.organizationId, variants.organizationId)))
    .where(and(eq(variants.id, variantId), eq(variants.organizationId, organizationId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Variant not found" });
  return rows[0];
}

export const copilotRouter = router({
  models: protectedProcedure.query(async () => {
    const response = await listLLMModels();
    return response.data.map(model => ({ id: model.id, owner: model.owned_by }));
  }),

  messages: protectedProcedure
    .input(z.object({ organizationId: z.number().int().positive(), conversationId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "variant:read");
      const db = await requireDb();
      const conversation = await db
        .select()
        .from(aiConversations)
        .where(
          and(
            eq(aiConversations.id, input.conversationId),
            eq(aiConversations.organizationId, input.organizationId)
          )
        )
        .limit(1);
      if (!conversation[0]) throw new TRPCError({ code: "NOT_FOUND" });
      const messages = await db
        .select()
        .from(aiMessages)
        .where(
          and(
            eq(aiMessages.organizationId, input.organizationId),
            eq(aiMessages.conversationId, input.conversationId)
          )
        )
        .orderBy(asc(aiMessages.createdAt));
      return { conversation: conversation[0], messages };
    }),

  ask: protectedProcedure
    .input(
      z.object({
        organizationId: z.number().int().positive(),
        variantId: z.number().int().positive(),
        conversationId: z.number().int().positive().optional(),
        modelId: z.string().trim().min(2).max(120).optional(),
        question: z.string().trim().min(5).max(5000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrganizationPermission(ctx.user.id, input.organizationId, "interpretation:edit");
      const context = await requireVariantContext(input.organizationId, input.variantId);
      const db = await requireDb();
      const evidence = await db
        .select()
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.organizationId, input.organizationId),
            eq(evidenceItems.variantId, input.variantId)
          )
        )
        .orderBy(desc(evidenceItems.createdAt));
      if (!evidence.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The Evidence Ledger is empty. Collect public evidence first or add reviewed evidence.",
        });
      }

      const catalog = await listLLMModels();
      const availableIds = new Set(catalog.data.map(model => model.id));
      const requestedModel = input.modelId || "gpt-5-mini";
      if (!availableIds.has(requestedModel)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Selected model is not available" });
      }

      let conversationId = input.conversationId;
      let modelId = requestedModel;
      if (conversationId) {
        const rows = await db
          .select()
          .from(aiConversations)
          .where(
            and(
              eq(aiConversations.id, conversationId),
              eq(aiConversations.organizationId, input.organizationId),
              eq(aiConversations.variantId, input.variantId)
            )
          )
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
        modelId = rows[0].modelId;
      } else {
        const result = await db.insert(aiConversations).values({
          organizationId: input.organizationId,
          variantId: input.variantId,
          title: input.question.slice(0, 120),
          modelId,
          createdBy: ctx.user.id,
        });
        conversationId = Number(result[0].insertId);
      }

      const previous = await db
        .select()
        .from(aiMessages)
        .where(
          and(
            eq(aiMessages.organizationId, input.organizationId),
            eq(aiMessages.conversationId, conversationId)
          )
        )
        .orderBy(asc(aiMessages.createdAt))
        .limit(12);

      await db.insert(aiMessages).values({
        organizationId: input.organizationId,
        conversationId,
        role: "user",
        content: input.question,
        citationIds: [],
      });

      const evidenceBlock = evidence
        .map(
          item =>
            `[E${item.id}] Source=${item.source}; Domain=${item.clinicalDomain}; Direction=${item.direction}; ` +
            `Title=${item.title}; Accessed=${item.accessedAt.toISOString()}; URL=${item.url || "not provided"}; ` +
            `Excerpt=${item.excerpt}`
        )
        .join("\n\n");
      const currentInterpretation = await db
        .select()
        .from(interpretations)
        .where(
          and(
            eq(interpretations.organizationId, input.organizationId),
            eq(interpretations.variantId, input.variantId)
          )
        )
        .orderBy(desc(interpretations.version))
        .limit(1);

      const variantBlock = JSON.stringify({
        purpose: context.clinicalCase.purpose,
        indication: context.clinicalCase.indication,
        referenceBuild: context.variant.referenceBuild,
        normalizedId: context.variant.normalizedId,
        gene: context.variant.gene,
        hgvsC: context.variant.hgvsC,
        hgvsP: context.variant.hgvsP,
        consequence: context.variant.consequence,
        populationAf: context.variant.populationAf,
        vaf: context.variant.vaf,
        readDepth: context.variant.readDepth,
        currentInterpretation: currentInterpretation[0] || null,
      });

      const response = await invokeLLM({
        model: modelId,
        messages: [
          { role: "system", content: COPILOT_SYSTEM_PROMPT },
          { role: "user", content: `VARIANT CONTEXT\n${variantBlock}\n\nEVIDENCE LEDGER\n${evidenceBlock}` },
          ...previous.map(message => ({ role: message.role, content: message.content } as const)),
          { role: "user", content: input.question },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "gvi_copilot_response",
            strict: true,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                draftInterpretation: { type: "string" },
                citedEvidenceIds: { type: "array", items: { type: "integer" } },
                uncitedClaims: { type: "array", items: { type: "string" } },
                limitations: { type: "array", items: { type: "string" } },
                suggestedNextSteps: { type: "array", items: { type: "string" } },
              },
              required: ["answer", "draftInterpretation", "citedEvidenceIds", "uncitedClaims", "limitations", "suggestedNextSteps"],
              additionalProperties: false,
            },
          },
        },
      });
      const rawContent = textContent(response.choices[0]?.message.content);
      let parsed: z.infer<typeof copilotOutputSchema>;
      try {
        parsed = copilotOutputSchema.parse(JSON.parse(rawContent));
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Copilot returned an invalid structured response" });
      }
      if (!citationsBelongToVariant(parsed.citedEvidenceIds, evidence.map(item => item.id))) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Copilot cited evidence outside the selected variant" });
      }
      const rendered = [
        parsed.answer,
        parsed.draftInterpretation ? `\n\n**Interpretation Draft**\n${parsed.draftInterpretation}` : "",
        parsed.limitations.length ? `\n\n**Limitations**\n${parsed.limitations.map(item => `- ${item}`).join("\n")}` : "",
        parsed.suggestedNextSteps.length ? `\n\n**Suggested Next Steps**\n${parsed.suggestedNextSteps.map(item => `- ${item}`).join("\n")}` : "",
        parsed.uncitedClaims.length ? `\n\n> **Citation verification required:** ${parsed.uncitedClaims.join("; ")}` : "",
      ].join("");
      await db.insert(aiMessages).values({
        organizationId: input.organizationId,
        conversationId,
        role: "assistant",
        content: rendered,
        citationIds: uniqueCitationIds(parsed.citedEvidenceIds),
      });
      await writeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: ctx.user.id,
        action: "copilot.response_generated",
        entityType: "ai_conversation",
        entityId: conversationId,
        after: {
          variantId: input.variantId,
          modelId: response.model || modelId,
          citedEvidenceIds: parsed.citedEvidenceIds,
          uncitedClaimCount: parsed.uncitedClaims.length,
        },
        req: ctx.req,
      });
      return {
        conversationId,
        modelId: response.model || modelId,
        content: rendered,
        citationIds: uniqueCitationIds(parsed.citedEvidenceIds),
        guardrails: {
          finalClassificationAllowed: false,
          reportSigningAllowed: false,
          uncitedClaimCount: parsed.uncitedClaims.length,
        },
      };
    }),
});

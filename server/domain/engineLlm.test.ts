import { describe, expect, it } from "vitest";
import { ENGINE_LLM_SYSTEM_PROMPT, llmChoiceText } from "./engineLlm";

describe("engine LLM proxy", () => {
  it("forbids a final classification in the system prompt", () => {
    expect(ENGINE_LLM_SYSTEM_PROMPT).toMatch(/Never make a final ACMG\/AMP classification/);
    expect(ENGINE_LLM_SYSTEM_PROMPT).toMatch(/AMP\/ASCO\/CAP/);
  });

  it("reads a plain-text chat completion", () => {
    expect(
      llmChoiceText({
        id: "x",
        created: 0,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "  LOF  " }, finish_reason: "stop" }],
      })
    ).toBe("  LOF  ");
  });

  it("joins text parts and ignores non-text content", () => {
    expect(
      llmChoiceText({
        id: "x",
        created: 0,
        model: "test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Gene " },
                { type: "image_url", image_url: { url: "https://example.test/x.png" } },
                { type: "text", text: "profile" },
              ],
            },
            finish_reason: "stop",
          },
        ],
      })
    ).toBe("Gene profile");
  });
});

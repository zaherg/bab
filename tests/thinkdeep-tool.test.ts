import { describe, expect, test } from "bun:test";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createThinkDeepTool } from "../src/tools/thinkdeep";

function createConfig(env: Record<string, string> = {}): BabConfig {
  return {
    env,
    paths: {
      baseDir: "/tmp/.config/bab",
      envFile: "/tmp/.config/bab/env",
      pluginsDir: "/tmp/.config/bab/plugins",
      promptsDir: "/tmp/.config/bab/prompts",
    },
  };
}

describe("thinkdeep tool", () => {
  test("runs expert analysis on the final step", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createThinkDeepTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({
          OPENAI_API_KEY: "openai-key",
        }),
        generateTextFn: async (args) => {
          calls.push(args as Record<string, unknown>);

          return {
            finishReason: "stop",
            providerMetadata: undefined,
            reasoning: [],
            request: {},
            response: {
              id: `resp_thinkdeep_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "primary-analysis" : "expert-analysis",
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
            },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings: "Collected strong evidence about the bug",
      hypothesis: "The issue is caused by stale state",
      next_step_required: false,
      problem_context: "Intermittent bug in a multistep workflow",
      step: "Summarize the investigation",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected thinkdeep success");
    }

    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.prompt)).toContain(
      "Validate and strengthen this thinkdeep analysis.",
    );

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.response).toBe("primary-analysis");
    expect(payload.expert_analysis).toBe("expert-analysis");
    expect(payload.thinking_complete).toBeTrue();
  });
});

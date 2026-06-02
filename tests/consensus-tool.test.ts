import { describe, expect, test } from "bun:test";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ModelGateway } from "../src/providers/model-gateway";
import { ProviderRegistry } from "../src/providers/registry";
import { createConsensusTool } from "../src/tools/consensus";

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

describe("consensus tool", () => {
  test("consults each model configuration and synthesizes a final answer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = new ProviderRegistry({
      config: createConfig({
        OPENAI_API_KEY: "openai-key",
      }),
      generateTextFn: async (args) => {
        calls.push(args as Record<string, unknown>);

        const texts = [
          "pro-argument",
          "counter-argument",
          "combined-synthesis",
        ];

        return {
          finishReason: "stop",
          providerMetadata: undefined,
          reasoning: [],
          request: {},
          response: {
            id: `resp_consensus_${calls.length}`,
            modelId: "gpt-5.2",
            timestamp: new Date("2026-03-10T12:00:00.000Z"),
          },
          steps: [],
          text: texts[calls.length - 1] ?? "unexpected",
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
          },
          warnings: undefined,
        } as never;
      },
    });
    const tool = createConsensusTool({
      conversationStore: new ConversationStore(),
      modelGateway: new ModelGateway(
        providerRegistry,
        createConfig({ OPENAI_API_KEY: "openai-key" }),
      ),
      providerRegistry,
    });
    const result = await tool.execute({
      findings: "The team needs a database migration strategy",
      models: [
        {
          model: "gpt-5.2",
          stance: "for",
        },
        {
          model: "gpt-5.2",
          stance: "against",
        },
      ],
      next_step_required: false,
      step: "Evaluate whether the migration should happen this quarter",
      step_number: 3,
      total_steps: 3,
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected consensus success");
    }

    expect(calls).toHaveLength(3);
    expect(String(calls[0]?.prompt)).toContain("stance: for");
    expect(String(calls[1]?.prompt)).toContain("stance: against");

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.response).toBe("combined-synthesis");
    expect(payload.synthesis).toBe("combined-synthesis");
    expect(payload.next_step_required).toBeFalse();
    expect(payload.model_responses).toHaveLength(2);
  });

  test("processes one model at a time when next_step_required is true", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = new ProviderRegistry({
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
            id: `resp_consensus_${calls.length}`,
            modelId: "gpt-5.2",
            timestamp: new Date("2026-03-10T12:00:00.000Z"),
          },
          steps: [],
          text: `response-${calls.length}`,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
          warnings: undefined,
        } as never;
      },
    });
    const tool = createConsensusTool({
      conversationStore: new ConversationStore(),
      modelGateway: new ModelGateway(
        providerRegistry,
        createConfig({ OPENAI_API_KEY: "openai-key" }),
      ),
      providerRegistry,
    });
    const result = await tool.execute({
      findings: "Need multi-model input",
      models: [
        { model: "gpt-5.2", stance: "for" },
        { model: "gpt-5.2", stance: "against" },
      ],
      next_step_required: true,
      step: "Evaluate approach",
      step_number: 1,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);

    if (!result.ok) {
      throw new Error("Expected consensus success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.next_step_required).toBeTrue();
    expect(payload.current_model_index).toBe(1);
    expect(payload.model_responses).toHaveLength(1);
    expect(payload.synthesis).toBeUndefined();
  });

  test("returns an error when a model is not found", async () => {
    const providerRegistry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "openai-key" }),
    });
    const tool = createConsensusTool({
      conversationStore: new ConversationStore(),
      modelGateway: new ModelGateway(
        providerRegistry,
        createConfig({ OPENAI_API_KEY: "openai-key" }),
      ),
      providerRegistry,
    });
    const result = await tool.execute({
      findings: "Test",
      models: [
        { model: "nonexistent-model", stance: "for" },
        { model: "gpt-5.2", stance: "against" },
      ],
      next_step_required: false,
      step: "Evaluate",
      step_number: 1,
      total_steps: 1,
    });

    expect(result.ok).toBeFalse();
  });

  test("rejects fewer than 2 models", async () => {
    const providerRegistry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "openai-key" }),
    });
    const tool = createConsensusTool({
      conversationStore: new ConversationStore(),
      modelGateway: new ModelGateway(
        providerRegistry,
        createConfig({ OPENAI_API_KEY: "openai-key" }),
      ),
      providerRegistry,
    });
    const result = await tool.execute({
      findings: "Test",
      models: [{ model: "gpt-5.2", stance: "for" }],
      next_step_required: false,
      step: "Evaluate",
      step_number: 1,
      total_steps: 1,
    });

    expect(result.ok).toBeFalse();
  });
});

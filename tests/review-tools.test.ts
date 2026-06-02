import { describe, expect, test } from "bun:test";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createChallengeTool } from "../src/tools/challenge";
import { createPrecommitTool } from "../src/tools/precommit";
import { createSecauditTool } from "../src/tools/secaudit";

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

describe("review tools", () => {
  test("secaudit runs expert validation for a completed audit step", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createSecauditTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({ OPENAI_API_KEY: "openai-key" }),
        generateTextFn: async (args) => {
          calls.push(args as Record<string, unknown>);
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            reasoning: [],
            request: {},
            response: {
              id: `resp_secaudit_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text:
              calls.length === 1 ? "security-audit" : "security-audit-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      audit_focus: "owasp",
      findings: "Found missing CSRF protection on state-changing endpoints.",
      next_step_required: false,
      step: "Finalize the security findings",
      step_number: 2,
      threat_level: "high",
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);

    if (!result.ok) {
      throw new Error("Expected secaudit success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.audit_focus).toBe("owasp");
    expect(payload.expert_analysis).toBe("security-audit-expert");
  });

  test("precommit runs expert validation and preserves repo metadata", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createPrecommitTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({ OPENAI_API_KEY: "openai-key" }),
        generateTextFn: async (args) => {
          calls.push(args as Record<string, unknown>);
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            reasoning: [],
            request: {},
            response: {
              id: `resp_precommit_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "precommit-review" : "precommit-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings: "Main risk is an untested schema migration.",
      next_step_required: false,
      path: "/virtual/workspace/bab",
      precommit_type: "external",
      step: "Summarize whether the change is ready to commit",
      step_number: 3,
      total_steps: 3,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);

    if (!result.ok) {
      throw new Error("Expected precommit success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.path).toBe("/virtual/workspace/bab");
    expect(payload.expert_analysis).toBe("precommit-expert");
  });

  test("challenge wraps statements without calling a provider", async () => {
    const tool = createChallengeTool();
    const result = await tool.execute({
      prompt: "This migration has zero operational risk.",
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected challenge success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.original_statement).toBe(
      "This migration has zero operational risk.",
    );
    expect(payload.challenge_prompt).toContain("CRITICAL REASSESSMENT");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createDocgenTool } from "../src/tools/docgen";
import { createRefactorTool } from "../src/tools/refactor";
import { createTestgenTool } from "../src/tools/testgen";

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

describe("transformation tools", () => {
  let tempDirectory: string | undefined;

  afterAll(async () => {
    try {
      if (tempDirectory)
        await rm(tempDirectory, { recursive: true, force: true });
    } catch {}
  });

  test("refactor runs expert validation and preserves opportunity metadata", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createRefactorTool({
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
              id: `resp_refactor_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "refactor-analysis" : "refactor-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings: "The module mixes orchestration and persistence logic.",
      issues_found: [
        {
          description: "Split orchestration from storage code",
          severity: "medium",
          type: "decompose",
        },
      ],
      next_step_required: false,
      refactor_type: "decompose",
      step: "Summarize the highest-value refactors",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);

    if (!result.ok) {
      throw new Error("Expected refactor success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.refactor_type).toBe("decompose");
    expect(payload.expert_analysis).toBe("refactor-expert");
  });

  test("testgen produces a file-backed test plan with expert follow-up", async () => {
    const calls: Array<Record<string, unknown>> = [];
    tempDirectory = await mkdtemp(join(process.cwd(), ".bab-test-testgen-"));
    const sourceFile = join(tempDirectory, "service.ts");

    await writeFile(
      sourceFile,
      "export async function loadUser(id: string) { return { id }; }\n",
    );

    const tool = createTestgenTool({
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
              id: `resp_testgen_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "test-plan" : "test-plan-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings: "Need happy-path, invalid-id, and transport-failure coverage.",
      next_step_required: false,
      relevant_files: [sourceFile],
      step: "Finalize the test scenarios",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.prompt)).toContain(`FILE: ${sourceFile}`);

    if (!result.ok) {
      throw new Error("Expected testgen success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.relevant_files).toEqual([sourceFile]);
    expect(payload.expert_analysis).toBe("test-plan-expert");
  });

  test("docgen stays single-pass and tracks documentation counters", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createDocgenTool({
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
              id: "resp_docgen",
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: "documentation-plan",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings: "One file still needs call-flow notes.",
      next_step_required: false,
      num_files_documented: 1,
      step: "Document the second and final file",
      step_number: 2,
      total_files_to_document: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);

    if (!result.ok) {
      throw new Error("Expected docgen success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.num_files_documented).toBe(1);
    expect(payload.total_files_to_document).toBe(2);
  });
});

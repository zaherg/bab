import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createAnalyzeTool } from "../src/tools/analyze";
import { createDebugTool } from "../src/tools/debug";
import { createTracerTool } from "../src/tools/tracer";

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

describe("investigation tools", () => {
  let analysisDirectory: string | undefined;

  afterAll(async () => {
    try {
      if (analysisDirectory)
        await rm(analysisDirectory, { recursive: true, force: true });
    } catch {}
  });

  test("debug runs expert validation on a completed investigation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createDebugTool({
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
              id: `resp_debug_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "debug-analysis" : "debug-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      confidence: "high",
      findings: "Reproduced the issue and narrowed it to stale cache state.",
      hypothesis: "Cache invalidation is skipped on retry",
      next_step_required: false,
      step: "Summarize the root cause",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);

    if (!result.ok) {
      throw new Error("Expected debug success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.response).toBe("debug-analysis");
    expect(payload.expert_analysis).toBe("debug-expert");
  });

  test("analyze embeds files and reports analysis metadata", async () => {
    const calls: Array<Record<string, unknown>> = [];
    analysisDirectory = await mkdtemp(
      join(process.cwd(), ".bab-test-analyze-"),
    );
    const analyzedFile = join(analysisDirectory, "module.ts");

    await writeFile(
      analyzedFile,
      "export const service = { enabled: true };\n",
    );

    const tool = createAnalyzeTool({
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
              id: `resp_analyze_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: calls.length === 1 ? "analysis-body" : "analysis-expert",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      analysis_type: "architecture",
      findings:
        "The module is cohesive but tightly coupled to configuration state.",
      next_step_required: false,
      output_format: "actionable",
      relevant_files: [analyzedFile],
      step: "Report architecture strengths and risks",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.prompt)).toContain(`FILE: ${analyzedFile}`);

    if (!result.ok) {
      throw new Error("Expected analyze success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.analysis_type).toBe("architecture");
    expect(payload.output_format).toBe("actionable");
    expect(payload.relevant_files).toEqual([analyzedFile]);
  });

  test("tracer stays single-pass when assistant analysis is disabled", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createTracerTool({
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
              id: "resp_tracer",
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text: "trace-analysis",
            usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
            warnings: undefined,
          } as never;
        },
      }),
    });
    const result = await tool.execute({
      findings:
        "The call chain starts in the controller and terminates in the repository.",
      next_step_required: false,
      step: "Summarize the dependency path",
      step_number: 1,
      target_description: "Trace how saveOrder reaches the database layer",
      total_steps: 1,
      trace_mode: "dependencies",
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);

    if (!result.ok) {
      throw new Error("Expected tracer success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.current_mode).toBe("dependencies");
    expect(payload.trace_complete).toBeTrue();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import {
  embedFiles,
  prepareConversation,
  remainingConversationTurns,
  selectModel,
} from "../src/tools/base";
import { createSimpleTool } from "../src/tools/simple";
import { WorkflowRunner } from "../src/tools/workflow/runner";

interface ChatToolRequest {
  absolute_file_paths?: string[];
  continuation_id?: string;
  prompt: string;
  thinking_mode?: "minimal" | "low" | "medium" | "high" | "max";
}

function createConfig(env: Record<string, string> = {}): BabConfig {
  return {
    env,
    lazyTools: false,
    paths: {
      baseDir: "/tmp/.config/bab",
      envFile: "/tmp/.config/bab/env",
      pluginsDir: "/tmp/.config/bab/plugins",
      promptsDir: "/tmp/.config/bab/prompts",
    },
    persistence: {
      enabled: false,
      enabledTools: new Set(),
      disabledTools: new Set(),
    },
  };
}

function createRegistry(calls: Array<Record<string, unknown>>) {
  return new ProviderRegistry({
    config: createConfig({
      OPENAI_API_KEY: "openai-key",
    }),
    generateTextFn: async (args) => {
      calls.push(args as Record<string, unknown>);

      const nextText =
        calls.length === 1
          ? "first-response"
          : calls.length === 2
            ? "follow-up-response"
            : "expert-summary";

      return {
        finishReason: "stop",
        providerMetadata: undefined,
        reasoning: [],
        request: {},
        response: {
          id: `resp_${calls.length}`,
          modelId: "gpt-5.2",
          timestamp: new Date("2026-03-10T12:00:00.000Z"),
        },
        steps: [],
        text: nextText,
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
        warnings: undefined,
      } as never;
    },
  });
}

describe("simple tool framework", () => {
  test("embeds files and preserves conversation history across continuation calls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const conversationStore = new ConversationStore();
    const tool = createSimpleTool<
      z.ZodObject<{
        absolute_file_paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        continuation_id: z.ZodOptional<z.ZodString>;
        prompt: z.ZodString;
      }>,
      ChatToolRequest
    >({
      buildPrompt: ({ fileContext, historyText, request }) =>
        [
          `Prompt: ${request.prompt}`,
          historyText ? `History:\n${historyText}` : "",
          fileContext.embedded_text
            ? `Files:\n${fileContext.embedded_text}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      context: {
        conversationStore,
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test chat tool",
      inputSchema: z.object({
        absolute_file_paths: z.array(z.string()).optional(),
        continuation_id: z.string().optional(),
        prompt: z.string(),
      }),
      name: "chat",
      systemPrompt: "system",
    });
    const tempDirectory = await mkdtemp(
      join(process.cwd(), ".bab-test-framework-"),
    );
    const sourceFile = join(tempDirectory, "example.ts");

    await writeFile(sourceFile, "export const answer = 42;\n");

    try {
      const firstResult = await tool.execute({
        absolute_file_paths: [sourceFile],
        prompt: "Inspect the file",
      });

      expect(firstResult.ok).toBeTrue();

      if (!firstResult.ok) {
        throw new Error("Expected successful first result");
      }

      const firstPayload = JSON.parse(firstResult.value.content ?? "{}");
      const firstContinuationId =
        firstResult.value.continuation_offer?.continuation_id ??
        String(firstPayload.continuation_id);

      expect(String(calls[0]?.prompt)).toContain(`FILE: ${sourceFile}`);
      expect(firstContinuationId.length).toBeGreaterThan(0);

      const secondResult = await tool.execute({
        continuation_id: firstContinuationId,
        prompt: "Continue the discussion",
      });

      expect(secondResult.ok).toBeTrue();

      if (!secondResult.ok) {
        throw new Error("Expected successful second result");
      }

      expect(calls).toHaveLength(2);
      expect(String(calls[1]?.prompt)).toContain("ASSISTANT\nfirst-response");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  test("forwards thinking_mode to provider calls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const inputSchema = z.object({
      prompt: z.string(),
      thinking_mode: z
        .enum(["minimal", "low", "medium", "high", "max"])
        .optional(),
    });
    const tool = createSimpleTool<typeof inputSchema, ChatToolRequest>({
      buildPrompt: ({ request }) => request.prompt,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test chat tool",
      inputSchema,
      name: "chat",
      systemPrompt: "system",
    });

    const result = await tool.execute({
      prompt: "think deeply",
      thinking_mode: "high",
    });

    expect(result.ok).toBeTrue();
    expect(calls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });
});

describe("workflow framework", () => {
  test("runs expert analysis on the final step and records the result", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildExpertPrompt: ({ primaryResponse }) =>
        `Validate:\n${primaryResponse}`,
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test workflow tool",
      formatPayload: ({
        aiResult,
        continuationId,
        expertAnalysis,
        request,
      }) => ({
        continuation_id: continuationId,
        expert_analysis: expertAnalysis?.text,
        response: aiResult.text,
        step_number: request.step_number,
      }),
      inputSchema: z.object({
        findings: z.string(),
        next_step_required: z.boolean(),
        step: z.string(),
        step_number: z.number().int().min(1),
        total_steps: z.number().int().min(1),
        use_assistant_model: z.boolean().optional(),
      }),
      name: "thinkdeep",
      systemPrompt: "system",
    });
    const result = await runner.asTool().execute({
      findings: "Collected evidence",
      next_step_required: false,
      step: "Investigate the issue",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected workflow success");
    }

    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.prompt)).toContain("Validate:\nfirst-response");

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.response).toBe("first-response");
    expect(payload.expert_analysis).toBe("follow-up-response");
  });

  test("forwards thinking_mode to workflow provider calls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test workflow tool",
      formatPayload: ({ aiResult }) => ({ response: aiResult.text }),
      inputSchema: z.object({
        findings: z.string(),
        next_step_required: z.boolean(),
        step: z.string(),
        step_number: z.number().int().min(1),
        thinking_mode: z
          .enum(["minimal", "low", "medium", "high", "max"])
          .optional(),
        total_steps: z.number().int().min(1),
        use_assistant_model: z.boolean().optional(),
      }),
      name: "thinkdeep",
      systemPrompt: "system",
    });

    const result = await runner.asTool().execute({
      findings: "Collected evidence",
      next_step_required: true,
      step: "Investigate the issue",
      step_number: 1,
      thinking_mode: "medium",
      total_steps: 2,
      use_assistant_model: false,
    });

    expect(result.ok).toBeTrue();
    expect(calls[0]?.providerOptions).toEqual({
      openai: { reasoningEffort: "medium" },
    });
  });

  test("runs expert analysis when confidence is certain even if next_step_required is true", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildExpertPrompt: ({ primaryResponse }) =>
        `Validate:\n${primaryResponse}`,
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test workflow tool",
      formatPayload: ({ aiResult, expertAnalysis }) => ({
        expert_analysis: expertAnalysis?.text,
        response: aiResult.text,
      }),
      inputSchema: z.object({
        confidence: z.string().optional(),
        findings: z.string(),
        next_step_required: z.boolean(),
        step: z.string(),
        step_number: z.number().int().min(1),
        total_steps: z.number().int().min(1),
        use_assistant_model: z.boolean().optional(),
      }),
      name: "thinkdeep",
      systemPrompt: "system",
    });
    const result = await runner.asTool().execute({
      confidence: "certain",
      findings: "Strong evidence",
      next_step_required: true,
      step: "Investigate",
      step_number: 1,
      total_steps: 3,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(2);

    if (!result.ok) {
      throw new Error("Expected workflow success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.expert_analysis).toBe("follow-up-response");
  });

  test("skips expert analysis mid-workflow when confidence is not certain", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildExpertPrompt: ({ primaryResponse }) =>
        `Validate:\n${primaryResponse}`,
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test workflow tool",
      formatPayload: ({ aiResult, expertAnalysis }) => ({
        expert_analysis: expertAnalysis?.text,
        response: aiResult.text,
      }),
      inputSchema: z.object({
        confidence: z.string().optional(),
        findings: z.string(),
        next_step_required: z.boolean(),
        step: z.string(),
        step_number: z.number().int().min(1),
        total_steps: z.number().int().min(1),
        use_assistant_model: z.boolean().optional(),
      }),
      name: "thinkdeep",
      systemPrompt: "system",
    });
    const result = await runner.asTool().execute({
      confidence: "medium",
      findings: "Partial evidence",
      next_step_required: true,
      step: "Investigate",
      step_number: 1,
      total_steps: 3,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);

    if (!result.ok) {
      throw new Error("Expected workflow success");
    }

    const payload = JSON.parse(result.value.content ?? "{}");
    expect(payload.expert_analysis).toBeUndefined();
  });

  test("returns execution error for invalid input schema", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test workflow tool",
      formatPayload: ({ aiResult }) => ({ response: aiResult.text }),
      inputSchema: z.object({
        findings: z.string().min(1),
        next_step_required: z.boolean(),
        step: z.string().min(1),
        step_number: z.number().int().min(1),
        total_steps: z.number().int().min(1),
      }),
      name: "validator",
      systemPrompt: "system",
    });
    const result = await runner.asTool().execute({
      next_step_required: false,
      step_number: 1,
      total_steps: 1,
    });

    expect(result.ok).toBeFalse();
    expect(calls).toHaveLength(0);
  });

  test("skips expert analysis when disabled", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const providerRegistry = createRegistry(calls);
    const runner = new WorkflowRunner({
      buildPrompt: ({ request }) => request.step,
      context: {
        conversationStore: new ConversationStore(),
        modelGateway: {} as never,
        providerRegistry,
      },
      description: "Test planner workflow",
      formatPayload: ({ aiResult }) => ({
        response: aiResult.text,
      }),
      inputSchema: z.object({
        findings: z.string(),
        next_step_required: z.boolean(),
        step: z.string(),
        step_number: z.number().int().min(1),
        total_steps: z.number().int().min(1),
        use_assistant_model: z.boolean().optional(),
      }),
      name: "planner",
      systemPrompt: "system",
    });
    const result = await runner.asTool().execute({
      findings: "Plan drafted",
      next_step_required: false,
      step: "Outline the rollout",
      step_number: 1,
      total_steps: 1,
      use_assistant_model: false,
    });

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);
  });
});

describe("selectModel", () => {
  test("falls back to best available when requested model provider is not configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ GOOGLE_API_KEY: "key" }),
    });

    const model = await selectModel(registry, "gpt-5.2");
    expect(model.provider).toBe("google");
  });

  test("falls back to best available when requested model does not exist", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });

    const model = await selectModel(registry, "nonexistent-model");
    expect(model.provider).toBe("openai");
  });

  test("throws when no providers are configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig(),
    });

    await expect(selectModel(registry)).rejects.toThrow(
      "No configured AI models are available",
    );
  });

  test("returns the highest-scoring model when none is requested", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });

    const model = await selectModel(registry);

    expect(model.provider).toBe("openai");
  });
});

describe("embedFiles", () => {
  test("skips non-existent files in allowed path", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });
    const model = await selectModel(registry);
    const nonExistent = join(process.cwd(), "nonexistent-bab-test-file.ts");

    const result = await embedFiles([nonExistent], model);
    expect(result.embedded_files).toHaveLength(0);
    expect(result.skipped_files).toHaveLength(1);
    expect(result.skipped_files[0]?.reason).toBe("file_not_found");
  });

  test("skips non-existent relative paths", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });
    const model = await selectModel(registry);

    const result = await embedFiles(["relative/nonexistent.ts"], model);
    expect(result.embedded_files).toHaveLength(0);
    expect(result.skipped_files).toHaveLength(1);
    expect(result.skipped_files[0]?.reason).toBe("file_not_found");
  });

  test("skips directories with not_a_file reason", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });
    const model = await selectModel(registry);
    const result = await embedFiles([process.cwd()], model);

    expect(result.embedded_files).toHaveLength(0);
    expect(result.skipped_files).toHaveLength(1);
    expect(result.skipped_files[0]?.reason).toBe("not_a_file");
  });

  test("deduplicates paths", async () => {
    const tempDirectory = await mkdtemp(
      join(process.cwd(), ".bab-test-dedup-"),
    );
    const filePath = join(tempDirectory, "dup.ts");

    try {
      await writeFile(filePath, "export const x = 1;\n");

      const registry = new ProviderRegistry({
        config: createConfig({ OPENAI_API_KEY: "key" }),
      });
      const model = await selectModel(registry);
      const result = await embedFiles([filePath, filePath, filePath], model);

      expect(result.embedded_files).toHaveLength(1);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(tempDirectory, { force: true, recursive: true });
    }
  });

  test("returns empty results for undefined paths", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });
    const model = await selectModel(registry);
    const result = await embedFiles(undefined, model);

    expect(result.embedded_files).toHaveLength(0);
    expect(result.total_tokens).toBe(0);
  });

  test("blocks paths outside cwd and allowed dirs", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });
    const model = await selectModel(registry);
    const home = require("node:os").homedir();
    const blockedFile = join(home, "bab-test-blocked.txt");

    try {
      await writeFile(blockedFile, "secret data\n");
      const result = await embedFiles([blockedFile], model);

      expect(result.embedded_files).toHaveLength(0);
      expect(result.skipped_files).toHaveLength(1);
      expect(result.skipped_files[0]?.reason).toBe("path_not_allowed");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(blockedFile, { force: true });
    }
  });
});

describe("prepareConversation", () => {
  test("creates a new thread for an invalid continuation id", async () => {
    const store = new ConversationStore();
    const conversation = await prepareConversation(store, "nonexistent-id");

    expect(conversation.continuationId).toBeDefined();
    expect(conversation.historyText).toBe("");
  });

  test("resumes an existing thread with history", async () => {
    const store = new ConversationStore();

    await store.addTurn("existing-thread", {
      content: "previous content",
      tool_name: "chat",
    });

    const conversation = await prepareConversation(store, "existing-thread");

    expect(conversation.continuationId).toBe("existing-thread");
    expect(conversation.historyText).toContain("previous content");
  });
});

describe("remainingConversationTurns", () => {
  test("returns undefined for undefined thread", () => {
    expect(remainingConversationTurns(undefined)).toBeUndefined();
  });

  test("returns 0 when thread is at capacity", () => {
    const thread = {
      created_at: new Date().toISOString(),
      id: "full-thread",
      updated_at: new Date().toISOString(),
      turns: Array.from({ length: 20 }, (_, i) => ({
        content: `turn-${i}`,
        created_at: new Date().toISOString(),
        tool_name: "chat",
      })),
    };

    expect(remainingConversationTurns(thread)).toBe(0);
  });

  test("clamps negative values to 0", () => {
    const thread = {
      created_at: new Date().toISOString(),
      id: "overfull-thread",
      updated_at: new Date().toISOString(),
      turns: Array.from({ length: 25 }, (_, i) => ({
        content: `turn-${i}`,
        created_at: new Date().toISOString(),
        tool_name: "chat",
      })),
    };

    expect(remainingConversationTurns(thread)).toBe(0);
  });
});

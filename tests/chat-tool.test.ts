import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BabConfig } from "../src/config";

import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createChatTool } from "../src/tools/chat";
import { estimateTokenCount } from "../src/utils/tokens";

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

describe("chat tool", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("returns a response with embedded file metadata", async () => {
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
            id: "resp_chat",
            modelId: "gpt-5.2",
            timestamp: new Date("2026-03-10T12:00:00.000Z"),
          },
          steps: [],
          text: "chat-response",
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
          },
          warnings: undefined,
        } as never;
      },
    });
    const tool = createChatTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry,
    });
    const workingDirectory = await mkdtemp(
      join(process.cwd(), ".bab-test-chat-tool-"),
    );
    tempDirs.push(workingDirectory);
    const sourceFile = join(workingDirectory, "context.ts");

    await writeFile(sourceFile, "export const featureFlag = true;\n");

    const result = await tool.execute({
      absolute_file_paths: [sourceFile],
      prompt: "Summarize the context",
      working_directory_absolute_path: workingDirectory,
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful chat result");
    }

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.prompt)).toContain(
      `Working directory: ${workingDirectory}`,
    );
    expect(String(calls[0]?.prompt)).toContain(`FILE: ${sourceFile}`);

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.response).toBe("chat-response");
    expect(payload.working_directory_absolute_path).toBe(workingDirectory);
    expect(payload.embedded_files).toEqual([
      {
        path: sourceFile,
        token_count: estimateTokenCount("export const featureFlag = true;\n"),
      },
    ]);
  });

  test("rejects a working directory that is a file", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "bab-chat-file-"));
    tempDirs.push(workingDirectory);
    const filePath = join(workingDirectory, "not-a-directory.txt");

    await writeFile(filePath, "content\n");

    const tool = createChatTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({
          OPENAI_API_KEY: "openai-key",
        }),
        generateTextFn: async () => {
          throw new Error("should not be called");
        },
      }),
    });
    const result = await tool.execute({
      prompt: "hello",
      working_directory_absolute_path: filePath,
    });

    expect(result.ok).toBeFalse();

    if (result.ok) {
      throw new Error("Expected chat validation failure");
    }

    expect(result.error.message).toContain("existing directory");
  });

  test("rejects a non-existent working directory", async () => {
    const tool = createChatTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({
          OPENAI_API_KEY: "openai-key",
        }),
        generateTextFn: async () => {
          throw new Error("should not be called");
        },
      }),
    });
    const result = await tool.execute({
      prompt: "hello",
      working_directory_absolute_path: "/tmp/nonexistent-bab-test-dir-xyz",
    });

    expect(result.ok).toBeFalse();

    if (result.ok) {
      throw new Error("Expected chat validation failure");
    }

    expect(result.error.message).toContain("existing directory");
  });

  test("rejects a non-absolute working directory", async () => {
    const tool = createChatTool({
      conversationStore: new ConversationStore(),
      modelGateway: {} as never,
      providerRegistry: new ProviderRegistry({
        config: createConfig({
          OPENAI_API_KEY: "openai-key",
        }),
        generateTextFn: async () => {
          throw new Error("should not be called");
        },
      }),
    });
    const result = await tool.execute({
      prompt: "hello",
      working_directory_absolute_path: "relative/path",
    });

    expect(result.ok).toBeFalse();

    if (result.ok) {
      throw new Error("Expected chat validation failure");
    }

    expect(result.error.message).toContain("absolute path");
  });
});

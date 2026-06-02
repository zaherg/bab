import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BabConfig } from "../src/config";
import { ConversationStore } from "../src/memory/conversations";
import { ProviderRegistry } from "../src/providers/registry";
import { createCodeReviewTool } from "../src/tools/codereview";

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

describe("codereview tool", () => {
  let reviewDirectory: string | undefined;

  afterAll(async () => {
    try {
      if (reviewDirectory)
        await rm(reviewDirectory, { recursive: true, force: true });
    } catch {}
  });

  test("embeds relevant files and runs expert validation on completion", async () => {
    const calls: Array<Record<string, unknown>> = [];
    reviewDirectory = await mkdtemp(
      join(process.cwd(), ".bab-test-codereview-"),
    );
    const reviewedFile = join(reviewDirectory, "reviewed.ts");

    await writeFile(
      reviewedFile,
      "export function sum(a: number, b: number) { return a + b; }\n",
    );

    const tool = createCodeReviewTool({
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
              id: `resp_review_${calls.length}`,
              modelId: "gpt-5.2",
              timestamp: new Date("2026-03-10T12:00:00.000Z"),
            },
            steps: [],
            text:
              calls.length === 1 ? "review-analysis" : "review-expert-analysis",
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
      files_checked: [reviewedFile],
      findings: "Initial pass found a few style concerns",
      next_step_required: false,
      relevant_files: [reviewedFile],
      review_type: "full",
      step: "Complete the review",
      step_number: 2,
      total_steps: 2,
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected code review success");
    }

    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.prompt)).toContain(`FILE: ${reviewedFile}`);
    expect(String(calls[1]?.prompt)).toContain(
      "Validate and strengthen this code review.",
    );

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.response).toBe("review-analysis");
    expect(payload.expert_analysis).toBe("review-expert-analysis");
    expect(payload.review_complete).toBeTrue();
    expect(payload.relevant_files).toEqual([reviewedFile]);
  });
});

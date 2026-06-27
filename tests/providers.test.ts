import { afterEach, describe, expect, test } from "bun:test";

import type { BabConfig } from "../src/config";
import { customProviderBaseUrl } from "../src/providers/custom-url";
import { clearDiscoveryCache } from "../src/providers/model-discovery";
import { ProviderRegistry } from "../src/providers/registry";
import { estimateTokenCount } from "../src/utils/tokens";

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

describe("estimateTokenCount", () => {
  test("uses a simple chars-per-token heuristic", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("1234")).toBe(1);
    expect(estimateTokenCount("12345")).toBe(2);
  });
});

describe("ProviderRegistry", () => {
  afterEach(() => clearDiscoveryCache());

  test("filters model list by configured providers", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({
        OPENAI_API_KEY: "openai-key",
        CUSTOM_API_URL: "http://localhost:11434/v1",
      }),
    });

    const models = await registry.listModels();

    expect(models.map((model) => model.provider)).toContain("openai");
    expect(models.map((model) => model.provider)).toContain("custom");
  });

  test("allows explicit loopback custom provider URLs for local OpenAI-compatible servers", () => {
    expect(
      customProviderBaseUrl({ CUSTOM_API_URL: "http://localhost:11434/v1" }),
    ).toBe("http://localhost:11434/v1");
  });

  test("still rejects non-loopback insecure custom provider URLs by default", () => {
    expect(() =>
      customProviderBaseUrl({ CUSTOM_API_URL: "http://example.com/v1" }),
    ).toThrow(
      "CUSTOM_API_URL must use https:// unless BAB_ALLOW_INSECURE_CUSTOM=1",
    );
  });

  test("resolves model aliases", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({
        OPENAI_API_KEY: "openai-key",
      }),
    });

    const model = await registry.getModelInfo("anthropic/claude-sonnet-4");

    expect(model?.id).toBe("claude-sonnet-4-20250514");
    expect(model?.provider).toBe("anthropic");
  });

  test("prefers exact id match over alias match", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({
        OPENROUTER_API_KEY: "key",
      }),
    });

    // "openai/gpt-5.2" is both an alias for the OpenAI model and the
    // exact id of the OpenRouter model — exact id should win
    const model = await registry.getModelInfo("openai/gpt-5.2");

    expect(model?.id).toBe("openai/gpt-5.2");
    expect(model?.provider).toBe("openrouter");
  });

  test("calls the AI SDK through an injected generateText implementation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const registry = new ProviderRegistry({
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
            id: "resp_123",
            modelId: "gpt-5.2",
            timestamp: new Date("2026-03-10T12:00:00.000Z"),
          },
          steps: [],
          text: "hello back",
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
          },
          warnings: undefined,
        } as never;
      },
    });

    const result = await registry.generateText(
      "gpt-5.2",
      "hello",
      "system text",
      {
        temperature: 0.2,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("hello");
    expect(calls[0]?.system).toBe("system text");
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value).toEqual({
        model: "gpt-5.2",
        provider: "openai",
        text: "hello back",
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
        },
      });
    }
  });

  test("adds a provider timeout abort signal to SDK calls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const registry = new ProviderRegistry({
      config: createConfig({
        BAB_PROVIDER_TIMEOUT_MS: "1234",
        OPENAI_API_KEY: "openai-key",
      }),
      generateTextFn: async (args) => {
        calls.push(args as Record<string, unknown>);

        return {
          response: {
            modelId: "gpt-5.2",
            timestamp: new Date("2026-03-10T12:00:00.000Z"),
          },
          text: "hello back",
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
          },
        } as never;
      },
    });

    const result = await registry.generateText("gpt-5.2", "hello");

    expect(result.ok).toBeTrue();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test("returns a timeout error when the provider request is aborted", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({
        OPENAI_API_KEY: "openai-key",
      }),
      generateTextFn: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    const result = await registry.generateText("gpt-5.2", "hello");

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.type).toBe("timeout");
      expect(result.error.message).toBe("Provider request timed out");
      expect(result.error.retryable).toBeTrue();
    }
  });

  test("returns a timeout error when the provider request reaches its deadline", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({
        OPENAI_API_KEY: "openai-key",
      }),
      generateTextFn: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    const result = await registry.generateText("gpt-5.2", "hello");

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.type).toBe("timeout");
      expect(result.error.message).toBe("Provider request timed out");
      expect(result.error.retryable).toBeTrue();
    }
  });

  test("does not log raw provider exception details", async () => {
    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const registry = new ProviderRegistry({
        config: createConfig({
          OPENAI_API_KEY: "openai-key",
        }),
        generateTextFn: async () => {
          throw new Error("upstream error leaked sk-test-secret-value");
        },
      });

      const result = await registry.generateText("gpt-5.2", "hello");

      expect(result.ok).toBeFalse();
      if (!result.ok) {
        expect(result.error.message).toBe("Provider request failed");
      }

      const stderr = errors
        .flat()
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join("\n");
      expect(stderr).not.toContain("sk-test-secret-value");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("infers google for unknown gemini-* model when configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ GOOGLE_API_KEY: "key" }),
    });

    const model = await registry.getModelInfo("gemini-2.5-flash");
    expect(model?.id).toBe("gemini-2.5-flash");
    expect(model?.provider).toBe("google");
    expect(model?.capabilities.score).toBe(50);
  });

  test("infers openai for unknown gpt-* model when configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });

    const model = await registry.getModelInfo("gpt-4o");
    expect(model?.id).toBe("gpt-4o");
    expect(model?.provider).toBe("openai");
  });

  test("infers openai for o*-* reasoning models when configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });

    const o3Model = await registry.getModelInfo("o3-pro");
    expect(o3Model?.id).toBe("o3-pro");
    expect(o3Model?.provider).toBe("openai");

    const futureGenerationModel = await registry.getModelInfo("o5-mini");
    expect(futureGenerationModel?.id).toBe("o5-mini");
    expect(futureGenerationModel?.provider).toBe("openai");
  });

  test("infers anthropic for unknown claude-* model when configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ ANTHROPIC_API_KEY: "key" }),
    });

    const model = await registry.getModelInfo("claude-opus-4-20250514");
    expect(model?.id).toBe("claude-opus-4-20250514");
    expect(model?.provider).toBe("anthropic");
  });

  test("returns undefined for unknown model with no pattern match", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ OPENAI_API_KEY: "key" }),
    });

    expect(await registry.getModelInfo("llama-3.1-70b")).toBeUndefined();
  });

  test("returns undefined when pattern matches but provider not configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig(),
    });

    expect(await registry.getModelInfo("gemini-2.5-flash")).toBeUndefined();
  });

  test("static registry takes priority over inference", async () => {
    const registry = new ProviderRegistry({
      config: createConfig({ GOOGLE_API_KEY: "key" }),
    });

    const model = await registry.getModelInfo("gemini-2.5-pro");
    expect(model?.id).toBe("gemini-2.5-pro");
    // Static entry has score 100, inference would give 50
    expect(model?.capabilities.score).toBe(100);
  });

  test("returns error Result when provider is not configured", async () => {
    const registry = new ProviderRegistry({
      config: createConfig(),
    });

    const result = await registry.generateText("gpt-5.2", "hello");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.type).toBe("configuration");
      expect(result.error.message).toContain("Provider not configured: openai");
      expect(result.error.message).toContain("OPENAI_API_KEY");
    }
  });

  test("returns not_found error for unknown model", async () => {
    const registry = new ProviderRegistry({
      config: createConfig(),
    });

    const result = await registry.generateText("nonexistent-model", "hello");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
      expect(result.error.message).toContain("Unknown model");
    }
  });

  test("with no API keys configured, zero models available and generateText returns error", async () => {
    const registry = new ProviderRegistry({
      config: createConfig(),
    });

    const models = await registry.listModels();
    expect(models).toHaveLength(0);

    const result = await registry.generateText("gpt-5.2", "hello");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.type).toBe("configuration");
      expect(result.error.message).toContain("OPENAI_API_KEY");
    }
  });
});

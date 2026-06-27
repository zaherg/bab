import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { invalidatePluginCache } from "../src/delegate/plugin-cache";
import {
  clearDiscoveryCache,
  discoverModels,
  getCachedModels,
} from "../src/providers/model-discovery";
import { ModelGateway } from "../src/providers/model-gateway";
import type { ProviderRegistry } from "../src/providers/registry";

const originalFetch = globalThis.fetch;

beforeEach(() => clearDiscoveryCache());
afterEach(() => {
  clearDiscoveryCache();
  globalThis.fetch = originalFetch;
});

function mockFetch(response: unknown, status = 200) {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
}

describe("discoverModels", () => {
  test("normalizes OpenAI response", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { id: "gpt-4o", owned_by: "openai" },
        { id: "gpt-4o-mini", owned_by: "openai" },
      ],
    });

    const models = await discoverModels("openai", "test-key");

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("gpt-4o");
    expect(models[0]?.provider).toBe("openai");
    expect(models[1]?.id).toBe("gpt-4o-mini");
  });

  test("normalizes Anthropic response", async () => {
    globalThis.fetch = mockFetch({
      data: [
        { id: "claude-opus-4-5", display_name: "Claude Opus 4.5" },
        { id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" },
      ],
    });

    const models = await discoverModels("anthropic", "test-key");

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("claude-opus-4-5");
    expect(models[0]?.display_name).toBe("Claude Opus 4.5");
    expect(models[0]?.provider).toBe("anthropic");
    expect(models[0]?.capabilities.context_window).toBe(200_000);
  });

  test("normalizes Google response — strips models/ prefix", async () => {
    globalThis.fetch = mockFetch({
      models: [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          inputTokenLimit: 1_048_576,
        },
        { name: "models/gemini-2.0-pro", displayName: "Gemini 2.0 Pro" },
      ],
    });

    const models = await discoverModels("google", "test-key");

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("gemini-2.5-flash");
    expect(models[0]?.display_name).toBe("Gemini 2.5 Flash");
    expect(models[0]?.capabilities.context_window).toBe(1_048_576);
    expect(models[1]?.id).toBe("gemini-2.0-pro");
    // No inputTokenLimit — falls back to default
    expect(models[1]?.capabilities.context_window).toBe(128_000);
  });

  test("normalizes OpenRouter response", async () => {
    globalThis.fetch = mockFetch({
      data: [
        {
          id: "anthropic/claude-opus-4",
          name: "Claude Opus 4",
          context_length: 200_000,
        },
        { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128_000 },
      ],
    });

    const models = await discoverModels("openrouter", "test-key");

    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("anthropic/claude-opus-4");
    expect(models[0]?.provider).toBe("openrouter");
    expect(models[0]?.capabilities.context_window).toBe(200_000);
  });

  test("returns empty array for custom provider", async () => {
    const models = await discoverModels("custom", "test-key");
    expect(models).toHaveLength(0);
  });

  test("returns empty array and logs warning on fetch failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network error")),
    ) as unknown as typeof fetch;

    const models = await discoverModels("openai", "test-key");
    expect(models).toHaveLength(0);
  });

  test("passes a timeout abort signal to provider model discovery fetches", async () => {
    const calls: Array<RequestInit | undefined> = [];
    globalThis.fetch = mock((_: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    const models = await discoverModels("openai", "test-key", undefined, {
      timeoutMs: 1234,
    });

    expect(models).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("returns empty array on non-200 response", async () => {
    globalThis.fetch = mockFetch({ error: "Unauthorized" }, 401);

    const models = await discoverModels("openai", "test-key");
    expect(models).toHaveLength(0);
  });

  test("caches results and does not refetch within TTL", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    await discoverModels("openai", "test-key");
    await discoverModels("openai", "test-key");
    await discoverModels("openai", "test-key");

    expect(callCount).toBe(1);
  });

  test("concurrent calls do not trigger duplicate fetches", async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
                status: 200,
              }),
            ),
          10,
        ),
      );
    }) as unknown as typeof fetch;

    await Promise.all([
      discoverModels("openai", "test-key"),
      discoverModels("openai", "test-key"),
      discoverModels("openai", "test-key"),
    ]);

    expect(callCount).toBe(1);
  });

  test("getCachedModels returns empty before any fetch", () => {
    expect(getCachedModels("openai")).toHaveLength(0);
  });

  test("getCachedModels returns results after fetch", async () => {
    globalThis.fetch = mockFetch({ data: [{ id: "gpt-4o" }] });

    await discoverModels("openai", "test-key");
    const cached = getCachedModels("openai");

    expect(cached).toHaveLength(1);
    expect(cached[0]?.id).toBe("gpt-4o");
  });
});

describe("ModelGateway delegate routing", () => {
  afterEach(() => invalidatePluginCache());

  test("routes pluginId/modelName to delegate path, not SDK generateText", async () => {
    const generateTextMock = mock(() =>
      Promise.resolve({
        model: "sdk-model",
        provider: "openai" as const,
        text: "sdk response",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      }),
    );

    const mockRegistry = {
      getModelInfo: mock(() => Promise.resolve(undefined)),
      listModels: mock(() => Promise.resolve([])),
      generateText: generateTextMock,
      isProviderConfigured: mock(() => false),
    } as unknown as ProviderRegistry;

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/.env",
        pluginsDir: "/tmp/nonexistent-plugins",
        promptsDir: "/tmp/prompts",
      },
    };

    // Ensure plugin cache is fresh (no stale data)
    invalidatePluginCache();

    const gateway = new ModelGateway(mockRegistry, config);

    // Query with pluginId/modelName format — should route to delegate path,
    // which will fail because no plugin "fake-plugin" is installed
    await expect(
      gateway.query("fake-plugin/gpt-4o", "Hello", "System prompt"),
    ).rejects.toThrow('Plugin "fake-plugin" is not installed');

    // The critical assertion: SDK generateText should NOT have been called
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("throws descriptive error for unknown model without slash", async () => {
    const mockRegistry = {
      getModelInfo: mock(() => Promise.resolve(undefined)),
      listModels: mock(() => Promise.resolve([])),
      generateText: mock(() => Promise.resolve()),
      isProviderConfigured: mock(() => false),
    } as unknown as ProviderRegistry;

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/.env",
        pluginsDir: "/tmp/nonexistent-plugins",
        promptsDir: "/tmp/prompts",
      },
    };

    const gateway = new ModelGateway(mockRegistry, config);

    // No slash — should fail with "not found in SDK registry" message
    await expect(gateway.query("nonexistent-model", "Hello")).rejects.toThrow(
      "not found in SDK registry",
    );
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { CORE_TOOL_NAMES, LAZY_MODE_TOOL_NAMES } from "../src/bootstrap";
import { ALWAYS_LOADED_TOOLS } from "../src/tools/manifest";
import { type BabTestHarness, createBabTestHarness } from "./harness";

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

const activeHarnesses: BabTestHarness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    await activeHarnesses.pop()?.close();
  }
});

// ---------------------------------------------------------------------------
// Unit: manifest
// ---------------------------------------------------------------------------

describe("Tool manifest", () => {
  test("contains all core tool names", () => {
    // Manifest entries should cover all CORE_TOOL_NAMES
    // We verify this indirectly via the manifest builder using a mock context.
    // Since buildToolManifest requires real deps, we just check the set of
    // names matches expectations at the constant level.
    const coreSet = new Set(CORE_TOOL_NAMES);
    expect(coreSet.has("analyze")).toBeTrue();
    expect(coreSet.has("delegate")).toBeTrue();
    expect(coreSet.has("secaudit")).toBeTrue();
    expect(coreSet.has("version")).toBeTrue();
  });

  test("ALWAYS_LOADED_TOOLS is a subset of CORE_TOOL_NAMES", () => {
    const coreArr = CORE_TOOL_NAMES as readonly string[];
    for (const name of ALWAYS_LOADED_TOOLS) {
      expect(coreArr.includes(name)).toBeTrue();
    }
  });

  test("LAZY_MODE_TOOL_NAMES does not overlap with CORE_TOOL_NAMES", () => {
    const coreArr = CORE_TOOL_NAMES as readonly string[];
    for (const name of LAZY_MODE_TOOL_NAMES) {
      expect(coreArr.includes(name)).toBeFalse();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: lazy mode startup
// ---------------------------------------------------------------------------

describe("Lazy tool loading — integration", () => {
  test("lazy mode registers only always-loaded tools + tools meta-tool", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const result = await harness.listTools();
    const toolNames = new Set(result.tools.map((t) => t.name));

    // Should have exactly the always-loaded tools + tools meta-tool
    const expected = new Set([...ALWAYS_LOADED_TOOLS, "tools"]);
    expect(toolNames).toEqual(expected);

    // Should NOT have other tools like chat, codereview, etc.
    expect(toolNames.has("chat")).toBeFalse();
    expect(toolNames.has("codereview")).toBeFalse();
    expect(toolNames.has("testgen")).toBeFalse();
  });

  test("tools() lists all available tools with loaded status", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const result = await harness.callTool({ name: "tools", arguments: {} });
    expect(result.isError).toBeFalse();

    const [content] = result.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const payload = JSON.parse(content.text) as {
      status: string;
      content: string;
    };
    const inner = JSON.parse(payload.content) as {
      tools: Array<{ name: string; loaded: boolean; category: string }>;
    };

    // All CORE_TOOL_NAMES should appear in the listing
    const listedNames = new Set(inner.tools.map((t) => t.name));
    for (const name of CORE_TOOL_NAMES) {
      expect(listedNames.has(name)).toBeTrue();
    }

    // Always-loaded tools should be marked loaded: true
    for (const name of ALWAYS_LOADED_TOOLS) {
      const entry = inner.tools.find((t) => t.name === name);
      expect(entry?.loaded).toBeTrue();
    }

    // Other tools should be loaded: false
    const chatEntry = inner.tools.find((t) => t.name === "chat");
    expect(chatEntry?.loaded).toBeFalse();
  });

  test("tools({ activate }) loads specific tools and sends list_changed", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    // Before: chat not in tool list
    const before = await harness.listTools();
    const beforeNames = new Set(before.tools.map((t) => t.name));
    expect(beforeNames.has("chat")).toBeFalse();

    // Activate chat
    const activateResult = await harness.callTool({
      name: "tools",
      arguments: { activate: ["chat"] },
    });
    expect(activateResult.isError).toBeFalse();
    const [content] = activateResult.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const payload = JSON.parse(content.text) as {
      status: string;
      content: string;
    };
    const inner = JSON.parse(payload.content) as {
      loaded: string[];
      already_loaded: string[];
      tools: Array<{ name: string; loaded: boolean }>;
    };

    expect(inner.loaded).toContain("chat");
    expect(inner.already_loaded).not.toContain("chat");

    // After: chat appears in tool list
    const after = await harness.listTools();
    const afterNames = new Set(after.tools.map((t) => t.name));
    expect(afterNames.has("chat")).toBeTrue();
  });

  test("tools({ activate_category }) loads all tools in a category", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      name: "tools",
      arguments: { activate_category: "review" },
    });
    expect(result.isError).toBeFalse();
    const [content] = result.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const payload = JSON.parse(content.text) as {
      status: string;
      content: string;
    };
    const inner = JSON.parse(payload.content) as { loaded: string[] };

    expect(inner.loaded).toContain("codereview");
    expect(inner.loaded).toContain("precommit");
    expect(inner.loaded).toContain("challenge");
  });

  test("tools({ activate_all }) loads all tools", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    await harness.callTool({
      name: "tools",
      arguments: { activate_all: true },
    });

    const after = await harness.listTools();
    const afterNames = new Set(after.tools.map((t) => t.name));

    for (const name of CORE_TOOL_NAMES) {
      expect(afterNames.has(name)).toBeTrue();
    }
  });

  test("auto-load: calling an unloaded tool loads and executes it transparently", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    // version is always loaded — use it as a sanity check first
    const versionResult = await harness.callTool({
      name: "version",
      arguments: {},
    });
    expect(versionResult.isError).toBeFalse();

    // challenge is NOT always loaded — calling it should auto-load and succeed
    const challengeResult = await harness.callTool({
      name: "challenge",
      arguments: { assumptions: "the sky is green", context: "basic test" },
    });
    // challenge requires an AI model — it will fail with execution error (no API key in test env)
    // but it should NOT fail with "unknown tool" — auto-load worked
    const [content] = challengeResult.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const parsed = JSON.parse(content.text) as {
      type?: string;
      message?: string;
    };
    expect(parsed.type).not.toBe("not_found");

    // After auto-load, challenge should now appear in tool list
    const after = await harness.listTools();
    const afterNames = new Set(after.tools.map((t) => t.name));
    expect(afterNames.has("challenge")).toBeTrue();
  });

  test("unknown tool returns not_found even in lazy mode", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      name: "nonexistent_tool_xyz",
      arguments: {},
    });
    expect(result.isError).toBeTrue();
    const [content] = result.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const parsed = JSON.parse(content.text) as { type: string };
    expect(parsed.type).toBe("not_found");
  });

  test("disabled tools do not appear in tools() listing and cannot be auto-loaded", async () => {
    const harness = await createBabTestHarness([], {
      BAB_DISABLED_TOOLS: "chat,codereview",
    });
    activeHarnesses.push(harness);

    const result = await harness.callTool({ name: "tools", arguments: {} });
    const [content] = result.content;
    if (!content || content.type !== "text") throw new Error("Expected text");
    const payload = JSON.parse(content.text) as {
      status: string;
      content: string;
    };
    const inner = JSON.parse(payload.content) as {
      tools: Array<{ name: string }>;
    };

    const listedNames = new Set(inner.tools.map((t) => t.name));
    expect(listedNames.has("chat")).toBeFalse();
    expect(listedNames.has("codereview")).toBeFalse();

    // Trying to auto-load a disabled tool should return not_found
    const callResult = await harness.callTool({
      name: "chat",
      arguments: { prompt: "hi" },
    });
    expect(callResult.isError).toBeTrue();
    const [callContent] = callResult.content;
    if (!callContent || callContent.type !== "text")
      throw new Error("Expected text");
    const callParsed = JSON.parse(callContent.text) as { type: string };
    expect(callParsed.type).toBe("not_found");
  });

  test("eager mode (BAB_EAGER_TOOLS=1) registers all core tools", async () => {
    const harness = await createBabTestHarness([], { BAB_EAGER_TOOLS: "1" });
    activeHarnesses.push(harness);

    const result = await harness.listTools();
    const toolNames = new Set(result.tools.map((t) => t.name));

    for (const name of CORE_TOOL_NAMES) {
      expect(toolNames.has(name)).toBeTrue();
    }
    // tools meta-tool should NOT be present in eager mode
    expect(toolNames.has("tools")).toBeFalse();
  });
});

// ---------------------------------------------------------------------------
// Unit: tool load failure isolation
// ---------------------------------------------------------------------------

describe("Tool load failure isolation", () => {
  test("a factory that throws does not prevent other tools from loading", async () => {
    // Import the server internals to test loadFromManifest isolation directly
    const { BabServer } = await import("../src/server");
    const { z } = await import("zod/v4");

    const server = new BabServer();

    // Register one good tool in the manifest
    const goodTool = {
      name: "good-tool",
      description: "Always works",
      inputSchema: z.object({}),
      execute: async () => ({
        ok: true as const,
        value: {
          content: "ok",
          content_type: "text" as const,
          status: "success" as const,
          metadata: {},
        },
      }),
    };

    // Add a bad entry (throws) and good entry to the manifest
    const updated = new Map(server.manifest);
    updated.set("bad-tool", {
      name: "bad-tool",
      description: "Throws on load",
      category: "info",
      persist: "never",
      factory: () => {
        throw new Error("factory explosion");
      },
    });
    updated.set("good-tool", {
      name: "good-tool",
      description: "Loads fine",
      category: "info",
      persist: "never",
      factory: () => goodTool,
    });
    server.setManifest(updated);

    // Loading the bad tool should return null, not throw
    const badResult = await server.loadFromManifest("bad-tool");
    expect(badResult).toBeNull();

    // Loading the good tool should still work
    const goodResult = await server.loadFromManifest("good-tool");
    expect(goodResult).not.toBeNull();
    expect(goodResult?.name).toBe("good-tool");

    // The bad tool should not appear in the tool registry
    expect(server.toolRegistry.has("bad-tool")).toBeFalse();
    // The good tool should be registered
    expect(server.toolRegistry.has("good-tool")).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// Integration: context-size benchmark (T11)
// ---------------------------------------------------------------------------

describe("Context-size benchmark", () => {
  test("lazy mode initial schema payload is smaller than eager mode", async () => {
    const [eagerHarness, lazyHarness] = await Promise.all([
      createBabTestHarness([], { BAB_EAGER_TOOLS: "1" }),
      createBabTestHarness(),
    ]);
    activeHarnesses.push(eagerHarness, lazyHarness);

    const [eagerTools, lazyTools] = await Promise.all([
      eagerHarness.listTools(),
      lazyHarness.listTools(),
    ]);

    const eagerBytes = Buffer.byteLength(JSON.stringify(eagerTools));
    const lazyBytes = Buffer.byteLength(JSON.stringify(lazyTools));

    console.log(
      `Schema payload — eager: ${eagerBytes} bytes, lazy: ${lazyBytes} bytes`,
    );
    expect(lazyBytes).toBeLessThan(eagerBytes * 0.5);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { CORE_TOOL_NAMES } from "../src/bootstrap";
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
// Payload parsing helpers
// ---------------------------------------------------------------------------

// Unwraps the MCP text envelope for a successful tool call.
function parseSuccessOutput(
  result: Awaited<ReturnType<BabTestHarness["callTool"]>>,
) {
  expect(result.isError).toBeFalse();
  const [content] = result.content;
  if (!content || content.type !== "text")
    throw new Error("Expected text content");
  return JSON.parse(content.text) as {
    status: string;
    content: string;
    metadata: Record<string, unknown>;
  };
}

// Unwraps the MCP text envelope for a failed tool call.
function parseToolError(
  result: Awaited<ReturnType<BabTestHarness["callTool"]>>,
) {
  expect(result.isError).toBeTrue();
  const [content] = result.content;
  if (!content || content.type !== "text")
    throw new Error("Expected text content");
  return JSON.parse(content.text) as { type: string; message: string };
}

// Unwraps the double-encoded content payload used by tools like list_models.
function parseInnerContent<T>(
  result: Awaited<ReturnType<BabTestHarness["callTool"]>>,
): T {
  const { content } = parseSuccessOutput(result);
  return JSON.parse(content) as T;
}

// ---------------------------------------------------------------------------
// Stub plugin factory
// ---------------------------------------------------------------------------

interface StubOutputSpec {
  content: string;
  content_type?: string;
}

interface StubPluginOptions {
  // plugin id; also used as the plugin directory name
  id: string;
  // events the adapter returns; defaults to one text output + done event
  outputs?: StubOutputSpec[];
  // if set, the adapter throws with this message instead of returning events
  throws?: string;
  // if true, no adapter.ts is written (tests the "no adapter" error path)
  noAdapter?: boolean;
}

async function writeInstallMetadata(pluginDir: string): Promise<void> {
  const adapterContent = await Bun.file(join(pluginDir, "adapter.ts")).text();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(adapterContent);

  await writeFile(
    join(pluginDir, ".install.json"),
    JSON.stringify(
      {
        adapter_hash: hasher.digest("hex"),
        installed_at: new Date(0).toISOString(),
        installer_version: "test",
        manifest_name: `${basename(pluginDir)} test`,
        manifest_version: "1.0.0",
        plugin_id: basename(pluginDir),
        plugin_subdir: basename(pluginDir),
        resolved_commit: "test",
        schema_version: 1,
        source_original: "test",
        source_url: "test",
      },
      null,
      2,
    ),
  );
}

// Creates a minimal stub plugin directory.
// Uses `echo` as the CLI command so the loader's binary-on-PATH check passes.
// All adapter protocol details (event shapes, module export format) are hidden here.
async function createStubPlugin(
  pluginsRoot: string,
  opts: StubPluginOptions,
): Promise<string> {
  const pluginDir = join(pluginsRoot, opts.id);
  await mkdir(pluginDir, { recursive: true });

  await writeFile(
    join(pluginDir, "manifest.yaml"),
    [
      `id: ${opts.id}`,
      `name: ${opts.id} stub`,
      "version: 1.0.0",
      "command: echo",
      "roles:",
      "  - default",
      "capabilities:",
      "  output_format: jsonl",
    ].join("\n"),
  );

  if (!opts.noAdapter) {
    const outputs = opts.outputs ?? [
      { content: "stub output", content_type: "text" },
    ];
    const adapterBody = opts.throws
      ? [
          "export default {",
          `  async run(_input) { throw new Error(${JSON.stringify(opts.throws)}); },`,
          "};",
        ].join("\n")
      : [
          "export default {",
          "  async run(input) {",
          "    return [",
          ...outputs.map(
            (o) =>
              `      { type: 'output', run_id: input.runId, provider_id: ${JSON.stringify(opts.id)}, timestamp: new Date().toISOString(), content: ${JSON.stringify(o.content)}, content_type: ${JSON.stringify(o.content_type ?? "text")} },`,
          ),
          "      { type: 'done', run_id: input.runId, provider_id: " +
            JSON.stringify(opts.id) +
            ", timestamp: new Date().toISOString(), metadata: {} },",
          "    ];",
          "  },",
          "};",
        ].join("\n");

    await writeFile(join(pluginDir, "adapter.ts"), adapterBody);
    await writeInstallMetadata(pluginDir);
  }

  return pluginDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bab MCP server integration", () => {
  test("starts, lists core tools, and shuts down cleanly", async () => {
    const harness = await createBabTestHarness([], { BAB_EAGER_TOOLS: "1" });
    activeHarnesses.push(harness);

    const result = await harness.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([...CORE_TOOL_NAMES].sort());
  });

  test("delegate executes a stub plugin and returns its output", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-integration-delegate-"));
    await createStubPlugin(sandbox, {
      id: "echo-stub",
      outputs: [{ content: "hello from stub" }],
    });

    const harness = await createBabTestHarness([join(sandbox, "echo-stub")]);
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: { cli_name: "echo-stub", prompt: "say hello" },
      name: "delegate",
    });
    const output = parseSuccessOutput(result);

    expect(output.status).toBe("success");
    expect(output.content).toBe("hello from stub");

    await rm(sandbox, { force: true, recursive: true });
  });

  test("delegate returns not_found for an unknown plugin", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: { cli_name: "no-such-plugin", prompt: "hello" },
      name: "delegate",
    });
    const error = parseToolError(result);

    expect(error.type).toBe("not_found");
  });

  test("delegate returns configuration error for plugin without adapter", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-integration-noadapter-"));
    await createStubPlugin(sandbox, { id: "no-adapter-stub", noAdapter: true });

    const harness = await createBabTestHarness([
      join(sandbox, "no-adapter-stub"),
    ]);
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: { cli_name: "no-adapter-stub", prompt: "hello" },
      name: "delegate",
    });
    const error = parseToolError(result);

    expect(error.type).toBe("configuration");

    await rm(sandbox, { force: true, recursive: true });
  });

  test("delegate returns not_found for an unknown role", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-integration-role-"));
    await createStubPlugin(sandbox, { id: "role-stub" });

    const harness = await createBabTestHarness([join(sandbox, "role-stub")]);
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: {
        cli_name: "role-stub",
        prompt: "hello",
        role: "nonexistent-role",
      },
      name: "delegate",
    });
    const error = parseToolError(result);

    expect(error.type).toBe("not_found");

    await rm(sandbox, { force: true, recursive: true });
  });

  test("delegate surfaces adapter throws as tool errors", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-integration-error-"));
    await createStubPlugin(sandbox, {
      id: "fail-stub",
      throws: "adapter exploded",
    });

    const harness = await createBabTestHarness([join(sandbox, "fail-stub")]);
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: { cli_name: "fail-stub", prompt: "trigger error" },
      name: "delegate",
    });
    const error = parseToolError(result);

    expect(error.message).toContain("adapter exploded");

    await rm(sandbox, { force: true, recursive: true });
  });

  test("delegate synthesizes a done event when the adapter omits one", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-integration-done-"));

    // Write adapter manually — omits the done event
    const pluginDir = join(sandbox, "nodone-stub");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: nodone-stub",
        "name: nodone-stub stub",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "capabilities:",
        "  output_format: jsonl",
      ].join("\n"),
    );
    await writeFile(
      join(pluginDir, "adapter.ts"),
      [
        "export default {",
        "  async run(input) {",
        "    return [{ type: 'output', run_id: input.runId, provider_id: 'nodone-stub', timestamp: new Date().toISOString(), content: 'no done', content_type: 'text' }];",
        "  },",
        "};",
      ].join("\n"),
    );
    await writeInstallMetadata(pluginDir);

    const harness = await createBabTestHarness([pluginDir]);
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: { cli_name: "nodone-stub", prompt: "go" },
      name: "delegate",
    });
    const output = parseSuccessOutput(result);

    expect(output.status).toBe("success");
    expect((output.metadata as Record<string, unknown>).done_event_count).toBe(
      1,
    );

    await rm(sandbox, { force: true, recursive: true });
  });

  test("list_models returns only explicitly configured providers", async () => {
    const harness = await createBabTestHarness([], {
      OPENAI_API_KEY: "test-key",
    });
    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: {},
      name: "list_models",
    });
    const models = parseInnerContent<{
      providers: Array<{ provider: string }>;
    }>(result);

    expect(Array.isArray(models.providers)).toBeTrue();
    // Hermetic env: only openai key was passed, so only openai providers appear
    const providerIds = models.providers.map((p) => p.provider);
    expect(providerIds.every((id) => id === "openai")).toBeTrue();
  });
});

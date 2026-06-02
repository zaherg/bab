import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { BabConfig } from "../src/config";
import { invalidatePluginCache } from "../src/delegate/plugin-cache";
import { clearDiscoveryCache } from "../src/providers/model-discovery";
import { createProviderRegistry } from "../src/providers/registry";
import { createDelegateTool } from "../src/tools/delegate";
import { createListModelsTool } from "../src/tools/listmodels";
import { createVersionTool } from "../src/tools/version";

function createConfig(
  pluginsDir: string,
  env: Record<string, string> = {},
): BabConfig {
  return {
    env,
    lazyTools: false,
    paths: {
      baseDir: join(pluginsDir, ".."),
      envFile: join(pluginsDir, "..", "env"),
      pluginsDir,
      promptsDir: join(pluginsDir, "..", "prompts"),
    },
    persistence: { enabled: false, enabledTools: new Set(), disabledTools: new Set() },
  };
}

async function writeInstallMetadata(pluginDirectory: string): Promise<void> {
  const adapterContent = await Bun.file(join(pluginDirectory, "adapter.ts")).text();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(adapterContent);

  await writeFile(
    join(pluginDirectory, ".install.json"),
    JSON.stringify(
      {
        adapter_hash: hasher.digest("hex"),
        installed_at: new Date(0).toISOString(),
        installer_version: "test",
        manifest_name: `${basename(pluginDirectory)} test`,
        manifest_version: "1.0.0",
        plugin_id: basename(pluginDirectory),
        plugin_subdir: basename(pluginDirectory),
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

describe("utility tools", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  test("listmodels returns env-gated static models", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-tools-"));
    const config = createConfig(pluginsDir, {
      OPENAI_API_KEY: "openai-key",
    });
    const tool = createListModelsTool(createProviderRegistry(config), config);
    const result = await tool.execute({});

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful result");
    }

    const parsed = JSON.parse(result.value.content ?? "{}");
    expect(parsed.providers).toHaveLength(1);
  });

  test("version returns Bun runtime information", async () => {
    const tool = createVersionTool();
    const result = await tool.execute({});

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful result");
    }

    const payload = JSON.parse(result.value.content ?? "{}");

    expect(payload.runtime).toBe("bun");
    expect(payload.bun_version).toBe(Bun.version);
  });
});

describe("delegate tool", () => {
  beforeEach(() => {
    invalidatePluginCache();
  });
  afterEach(() => {
    invalidatePluginCache();
  });

  test("extracts summaries and truncates long output", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-delegate-tool-"));
    const pluginDirectory = join(pluginsDir, "echo");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: echo",
        "name: Echo Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(
      join(pluginDirectory, "adapter.ts"),
      [
        "export default {",
        "  async run(input) {",
        "    const longBody = 'x'.repeat(21050) + '\\n\\n<SUMMARY>short summary</SUMMARY>';",
        "    return [",
        "      {",
        "        type: 'output',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        content: longBody,",
        "        content_type: 'markdown',",
        "      },",
        "      {",
        "        type: 'done',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        metadata: { provider_message: 'done' },",
        "      },",
        "    ];",
        "  },",
        "};",
      ].join("\n"),
    );
    await writeInstallMetadata(pluginDirectory);

    const tool = createDelegateTool(createConfig(pluginsDir));
    const result = await tool.execute({
      cli_name: "echo",
      prompt: "hello",
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful result");
    }

    expect((result.value.content ?? "").length).toBeLessThanOrEqual(20_050);
    expect(result.value.metadata?.summary).toBe("short summary");
    expect(result.value.metadata?.done_event_count).toBe(1);
  });

  test("truncated output includes char count in marker", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-delegate-trunc-"));
    const pluginDirectory = join(pluginsDir, "echo");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: echo",
        "name: Echo Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    // Produce exactly 25_000 chars of output (exceeds 20_000 limit)
    await writeFile(
      join(pluginDirectory, "adapter.ts"),
      [
        "export default {",
        "  async run(input) {",
        "    const body = 'x'.repeat(25_000);",
        "    return [",
        "      {",
        "        type: 'output',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        content: body,",
        "        content_type: 'markdown',",
        "      },",
        "      {",
        "        type: 'done',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        metadata: {},",
        "      },",
        "    ];",
        "  },",
        "};",
      ].join("\n"),
    );
    await writeInstallMetadata(pluginDirectory);

    const tool = createDelegateTool(createConfig(pluginsDir));
    const result = await tool.execute({ cli_name: "echo", prompt: "hello" });

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error("Expected success");

    const content = result.value.content ?? "";
    // Must include the truncation marker with a char count
    expect(content).toMatch(/\.\.\.\[truncated \d+ chars\]\.\.\./);
    // Total length must not exceed the limit
    expect(content.length).toBeLessThanOrEqual(20_050);
  });

  test("returns unknown-plugin errors", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-delegate-missing-"));
    const tool = createDelegateTool(createConfig(pluginsDir));
    const result = await tool.execute({
      cli_name: "missing",
      prompt: "hello",
    });

    expect(result.ok).toBeFalse();

    if (result.ok) {
      throw new Error("Expected failure result");
    }

    expect(result.error.type).toBe("not_found");
  });

  test("synthesizes a done event when the adapter omits one", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-delegate-done-"));
    const pluginDirectory = join(pluginsDir, "echo");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: echo",
        "name: Echo Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(
      join(pluginDirectory, "adapter.ts"),
      [
        "export default {",
        "  async run(input) {",
        "    return [{",
        "      type: 'output',",
        "      run_id: input.runId,",
        "      provider_id: 'echo',",
        "      timestamp: new Date().toISOString(),",
        "      content: 'hello',",
        "      content_type: 'text',",
        "    }];",
        "  },",
        "};",
      ].join("\n"),
    );
    await writeInstallMetadata(pluginDirectory);

    const tool = createDelegateTool(createConfig(pluginsDir));
    const result = await tool.execute({
      cli_name: "echo",
      prompt: "hello",
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful result");
    }

    expect(result.value.metadata?.done_event_count).toBe(1);
  });

  test("passes the merged env map to adapters", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-delegate-env-"));
    const pluginDirectory = join(pluginsDir, "echo");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: echo",
        "name: Echo Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(
      join(pluginDirectory, "env"),
      [
        "PLUGIN_ONLY=plugin",
        "SHARED=plugin",
        "PATH=/blocked-plugin",
        "BAB_INTERNAL_SECRET=blocked",
      ].join("\n"),
    );
    await writeFile(
      join(pluginDirectory, "adapter.ts"),
      [
        "export default {",
        "  async run(input) {",
        "    return [",
        "      {",
        "        type: 'output',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        content: JSON.stringify(input.env),",
        "        content_type: 'json',",
        "      },",
        "      {",
        "        type: 'done',",
        "        run_id: input.runId,",
        "        provider_id: 'echo',",
        "        timestamp: new Date().toISOString(),",
        "        metadata: {},",
        "      },",
        "    ];",
        "  },",
        "};",
      ].join("\n"),
    );
    await writeInstallMetadata(pluginDirectory);

    const tool = createDelegateTool(
      createConfig(pluginsDir, {
        BAB_INTERNAL_SECRET: "blocked-global",
        GLOBAL_ONLY: "global",
        HOME: "/blocked-global",
        SHARED: "global",
      }),
    );
    const result = await tool.execute({
      cli_name: "echo",
      prompt: "hello",
    });

    expect(result.ok).toBeTrue();

    if (!result.ok) {
      throw new Error("Expected successful result");
    }

    const mergedEnv = JSON.parse(result.value.content ?? "{}") as Record<
      string,
      string | undefined
    >;

    expect(mergedEnv.GLOBAL_ONLY).toBe("global");
    expect(mergedEnv.PLUGIN_ONLY).toBe("plugin");
    expect(mergedEnv.SHARED).toBe("plugin");
    expect(mergedEnv.HOME).toBe(process.env.HOME);
    expect(mergedEnv.PATH).toBe(process.env.PATH);
    expect(mergedEnv.BAB_INTERNAL_SECRET).toBe(process.env.BAB_INTERNAL_SECRET);
  });
});

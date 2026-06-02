import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPluginDirectories } from "../src/delegate/discovery";
import { loadPlugin } from "../src/delegate/loader";
import { PluginManifestSchema } from "../src/types";

const BASE_MANIFEST = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  command: "echo",
  roles: ["default"],
};

describe("tool_prompts manifest schema", () => {
  test("parses manifest with tool_prompts", () => {
    const parsed = PluginManifestSchema.parse({
      ...BASE_MANIFEST,
      tool_prompts: {
        codereview: "prompts/codereview.txt",
        debug: "prompts/debug.txt",
      },
    });

    expect(parsed.tool_prompts).toEqual({
      codereview: "prompts/codereview.txt",
      debug: "prompts/debug.txt",
    });
  });

  test("parses manifest without tool_prompts (optional)", () => {
    const parsed = PluginManifestSchema.parse(BASE_MANIFEST);

    expect(parsed.tool_prompts).toBeUndefined();
  });

  test("rejects tool_prompts with empty key or value", () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...BASE_MANIFEST,
        tool_prompts: { "": "prompts/codereview.txt" },
      }),
    ).toThrow();

    expect(() =>
      PluginManifestSchema.parse({
        ...BASE_MANIFEST,
        tool_prompts: { codereview: "" },
      }),
    ).toThrow();
  });

  test("rejects tool_prompts with non-string values", () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...BASE_MANIFEST,
        tool_prompts: { codereview: 42 },
      }),
    ).toThrow();
  });
});

describe("tool_prompts loader caching", () => {
  test("reads and caches prompt file contents at load time", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-"));
    const pluginDir = join(pluginsRoot, "test-plugin");
    const promptsDir = join(pluginDir, "prompts");

    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      join(promptsDir, "codereview.txt"),
      "You are a strict code reviewer for this plugin.",
    );
    await writeFile(
      join(promptsDir, "debug.txt"),
      "You are a debugging specialist for this plugin.",
    );
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: test-plugin",
        "name: Test Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "tool_prompts:",
        "  codereview: prompts/codereview.txt",
        "  debug: prompts/debug.txt",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    expect(loaded.resolvedToolPrompts).toBeDefined();
    expect(loaded.resolvedToolPrompts?.codereview).toBe(
      "You are a strict code reviewer for this plugin.",
    );
    expect(loaded.resolvedToolPrompts?.debug).toBe(
      "You are a debugging specialist for this plugin.",
    );
  });

  test("resolvedToolPrompts is undefined when manifest has no tool_prompts", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-none-"));
    const pluginDir = join(pluginsRoot, "no-prompts");

    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: no-prompts",
        "name: No Prompts Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    expect(loaded.resolvedToolPrompts).toBeUndefined();
  });

  test("loads good prompts and skips bad ones (partial success)", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-partial-"));
    const pluginDir = join(pluginsRoot, "partial");
    const promptsDir = join(pluginDir, "prompts");

    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "codereview.txt"), "Good prompt content.");
    // debug.txt does not exist — should be skipped

    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: partial",
        "name: Partial Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "tool_prompts:",
        "  codereview: prompts/codereview.txt",
        "  debug: prompts/missing.txt",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    expect(loaded.resolvedToolPrompts).toBeDefined();
    expect(loaded.resolvedToolPrompts?.codereview).toBe("Good prompt content.");
    expect(loaded.resolvedToolPrompts?.debug).toBeUndefined();
  });

  test("skips unknown tool names with warning", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-unknown-"));
    const pluginDir = join(pluginsRoot, "unknown-tool");
    const promptsDir = join(pluginDir, "prompts");

    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "foo.txt"), "Some prompt.");

    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: unknown-tool",
        "name: Unknown Tool Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "tool_prompts:",
        "  not_a_real_tool: prompts/foo.txt",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    // Unknown tool name is skipped, so no prompts are resolved
    expect(loaded.resolvedToolPrompts).toBeUndefined();
  });

  test("rejects ../traversal paths that escape plugin directory", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-dotdot-"));
    const pluginDir = join(pluginsRoot, "dotdot");

    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginsRoot, "secret.txt"), "secret prompt");

    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: dotdot",
        "name: Dotdot Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "tool_prompts:",
        "  codereview: ../secret.txt",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    // Path escape is caught; plugin still loads
    expect(loaded.resolvedToolPrompts).toBeUndefined();
  });

  test("rejects prompt file paths that escape plugin directory", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-tp-escape-"));
    const pluginDir = join(pluginsRoot, "escaper");
    const outsideDir = join(pluginsRoot, "outside");

    await mkdir(pluginDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "evil.txt"), "malicious prompt");

    // Create a symlink inside the plugin dir that points outside
    await symlink(
      join(outsideDir, "evil.txt"),
      join(pluginDir, "evil-link.txt"),
    );

    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: escaper",
        "name: Escaper Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "tool_prompts:",
        "  codereview: evil-link.txt",
      ].join("\n"),
    );

    const discovered = await discoverPluginDirectories(pluginsRoot);
    const loaded = await loadPlugin(discovered[0]!);

    // Bad prompt entry is skipped; plugin still loads
    expect(loaded.resolvedToolPrompts).toBeUndefined();
  });
});

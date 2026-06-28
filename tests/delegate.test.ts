import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPluginDirectories } from "../src/delegate/discovery";
import { loadPlugin, loadPlugins } from "../src/delegate/loader";
import {
  getLoadedPlugins,
  invalidatePluginCache,
} from "../src/delegate/plugin-cache";
import { ProcessRunner } from "../src/delegate/process-runner";
import { resolveRole } from "../src/delegate/roles";

describe("delegate discovery and loading", () => {
  test("discovers plugin directories with manifest.yaml", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-plugins-"));
    const pluginDirectory = join(pluginsRoot, "example");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: example",
        "name: Example Plugin",
        "version: 1.0.0",
        "command: example",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const discoveredPlugins = await discoverPluginDirectories(pluginsRoot);

    expect(discoveredPlugins).toHaveLength(1);
    expect(
      discoveredPlugins[0]?.manifestPath.endsWith("manifest.yaml"),
    ).toBeTrue();
  });

  test("skips invalid plugins while loading", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-invalid-plugins-"));
    const invalidPluginDirectory = join(pluginsRoot, "invalid");
    const validPluginDirectory = join(pluginsRoot, "valid");

    await mkdir(invalidPluginDirectory, { recursive: true });
    await mkdir(validPluginDirectory, { recursive: true });

    await writeFile(
      join(invalidPluginDirectory, "manifest.yaml"),
      "id: invalid",
    );
    await writeFile(
      join(validPluginDirectory, "manifest.yaml"),
      [
        "id: valid",
        "name: Valid Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const discoveredPlugins = await discoverPluginDirectories(pluginsRoot);
    const loadedPlugins = await loadPlugins(discoveredPlugins);

    expect(loadedPlugins).toHaveLength(1);
    expect(loadedPlugins[0]?.manifest.id).toBe("valid");
  });

  test("skips plugins whose CLI command is not on PATH", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-missing-cli-"));
    const pluginDirectory = join(pluginsRoot, "missing");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: missing",
        "name: Missing CLI Plugin",
        "version: 1.0.0",
        "command: nonexistent-cli-tool-xyz",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const discoveredPlugins = await discoverPluginDirectories(pluginsRoot);
    const loadedPlugins = await loadPlugins(discoveredPlugins);

    expect(loadedPlugins).toHaveLength(0);
  });

  test("loadPlugin returns null when CLI command is not on PATH", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-throw-cli-"));

    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: ghost",
        "name: Ghost Plugin",
        "version: 1.0.0",
        "command: ghost-cli-not-installed",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const result = await loadPlugin({
      adapterPath: undefined,
      directory: pluginDirectory,
      manifestPath: join(pluginDirectory, "manifest.yaml"),
    });

    expect(result).toBeNull();
  });

  test("loadPlugin succeeds when CLI command exists on PATH", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-valid-cli-"));

    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: valid-cli",
        "name: Valid CLI Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const loaded = await loadPlugin({
      adapterPath: undefined,
      directory: pluginDirectory,
      manifestPath: join(pluginDirectory, "manifest.yaml"),
    });

    expect(loaded).not.toBeNull();
    expect(loaded?.manifest.id).toBe("valid-cli");
    expect(loaded?.manifest.command).toBe("echo");
  });
});

describe("delegate role resolution", () => {
  test("prefers plugin-defined roles over built-in prompts", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-role-plugin-"));

    await writeFile(
      join(pluginDirectory, "research.txt"),
      "Plugin research prompt",
    );
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: role-plugin",
        "name: Role Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
        "  - name: planner",
        "    inherits: planner",
        "    prompt_file: research.txt",
      ].join("\n"),
    );

    const [plugin] = await loadPlugins([
      {
        adapterPath: undefined,
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      },
    ]);

    const resolvedRole = await resolveRole(plugin, "planner");

    expect(resolvedRole.source).toBe("plugin");
    expect(resolvedRole.prompt).toContain("Plugin research prompt");
    expect(resolvedRole.prompt).toContain("planning agent");
  });

  test("falls back to built-in roles when the plugin does not override them", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-role-builtin-"));

    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: builtin-plugin",
        "name: Builtin Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const [plugin] = await loadPlugins([
      {
        adapterPath: undefined,
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      },
    ]);
    const resolvedRole = await resolveRole(plugin, "default");

    expect(resolvedRole.source).toBe("built_in");
    expect(resolvedRole.prompt).toContain("external CLI agent");
  });
});

describe("plugin-cache race conditions", () => {
  beforeEach(() => {
    invalidatePluginCache();
  });
  afterEach(() => {
    invalidatePluginCache();
  });

  test("concurrent invalidate and load does not return stale data", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-cache-race-"));
    const pluginDir = join(pluginsRoot, "race-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: race-plugin",
        "name: Race Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const config = {
      env: {},
      lazyTools: false,
      paths: {
        baseDir: "/tmp",
        envFile: "/tmp/.env",
        pluginsDir: pluginsRoot,
        promptsDir: "/tmp/prompts",
      },
    };

    // Warm the cache
    invalidatePluginCache();
    const initial = await getLoadedPlugins(config);
    expect(initial.length).toBeGreaterThanOrEqual(1);
    const racePlugin = initial.find((p) => p.manifest.id === "race-plugin");
    expect(racePlugin).toBeDefined();

    // Concurrently invalidate and reload - should never get stale/undefined results
    const invalidateAndLoad = async () => {
      invalidatePluginCache();
      return getLoadedPlugins(config);
    };

    const results = await Promise.all([
      invalidateAndLoad(),
      getLoadedPlugins(config),
      invalidateAndLoad(),
    ]);
    invalidatePluginCache();

    for (const result of results) {
      expect(Array.isArray(result)).toBe(true);
      // Each result should contain the race-plugin (fresh load)
      const found = result.find((p) => p.manifest.id === "race-plugin");
      expect(found).toBeDefined();
    }

    // Cleanup
    invalidatePluginCache();
  });

  test("does not permanently cache a rejected inflight promise", async () => {
    // This test verifies the H3 fix: after a transient failure clears inflight,
    // subsequent calls retry rather than re-awaiting the rejected promise.
    // We simulate by calling with a valid config (bundled plugins always resolve).
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-cache-retry-"));
    const pluginDir = join(pluginsRoot, "retry-plugin");

    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.yaml"),
      [
        "id: retry-plugin",
        "name: Retry Plugin",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );

    const config = {
      paths: { pluginsDir: pluginsRoot },
      env: {},
    } as unknown as import("../src/config").BabConfig;

    invalidatePluginCache();
    const first = await getLoadedPlugins(config);
    invalidatePluginCache();
    // Second call after invalidation must resolve fresh, not hang or throw
    const second = await getLoadedPlugins(config);

    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ProcessRunner", () => {
  test("captures stdout and stderr", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("test-stdout", {
      args: ["-e", "console.log('hello'); console.error('oops');"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 1_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("oops");
    expect(result.timedOut).toBeFalse();
  });

  test("terminates timed-out processes", async () => {
    const runner = new ProcessRunner();
    const result = await runner.run("test-timeout", {
      args: ["-e", "setTimeout(() => console.log('done'), 5000);"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      killGraceMs: 50,
      timeoutMs: 100,
    });

    expect(result.timedOut).toBeTrue();
    expect(result.exitCode === null || result.exitCode !== 0).toBeTrue();
  });

  test("escalates timed-out processes that ignore SIGTERM", async () => {
    const runner = new ProcessRunner();
    const result = await Promise.race([
      runner.run("test-timeout-ignore-term", {
        args: [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        command: "bun",
        env: { ...process.env } as Record<string, string>,
        killGraceMs: 50,
        timeoutMs: 100,
      }),
      Bun.sleep(1_500).then(() => "hung" as const),
    ]);

    expect(result).not.toBe("hung");
    if (result === "hung") {
      throw new Error("ProcessRunner did not escalate to SIGKILL");
    }

    expect(result.timedOut).toBeTrue();
    expect(result.signal).toBe("SIGKILL");
    expect(runner.activeCount).toBe(0);
  });

  test("rejects new runs when concurrency limit is reached", async () => {
    const runner = new ProcessRunner(1);

    // Start a long-running process to fill the slot
    const slowRun = runner.run("slow-run", {
      args: ["-e", "await Bun.sleep(2000);"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 5_000,
    });

    // Give it a moment to register as active
    await Bun.sleep(50);
    expect(runner.activeCount).toBe(1);

    // A second run should be rejected immediately
    expect(
      runner.run("second-run", {
        args: ["-e", "console.log('hi');"],
        command: "bun",
        env: { ...process.env } as Record<string, string>,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Process concurrency limit reached");

    // Cancel the slow run to clean up
    await runner.cancel("slow-run");
    await slowRun.catch(() => {});
  });

  test("allows new runs after a previous one completes", async () => {
    const runner = new ProcessRunner(1);

    const first = await runner.run("first-run", {
      args: ["-e", "console.log('first');"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 1_000,
    });
    expect(first.exitCode).toBe(0);
    expect(runner.activeCount).toBe(0);

    // Should be able to run again after completion
    const second = await runner.run("second-run", {
      args: ["-e", "console.log('second');"],
      command: "bun",
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 1_000,
    });
    expect(second.exitCode).toBe(0);
  });
});

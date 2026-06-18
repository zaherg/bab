import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPluginsFromSource, runAddCommand } from "../src/commands/add";
import { runListCommand } from "../src/commands/list";
import { runRemoveCommand } from "../src/commands/remove";
import { getBundledPluginsRoot } from "../src/commands/shared";
import { parseSource } from "../src/commands/source-parser";
import type { BabConfig } from "../src/config";

interface CaptureStream {
  write(chunk: string): boolean;
}

function createConfig(pluginsDir: string): BabConfig {
  return {
    env: {},
    paths: {
      baseDir: join(pluginsDir, ".."),
      envFile: join(pluginsDir, "..", "env"),
      pluginsDir,
      promptsDir: join(pluginsDir, "..", "prompts"),
    },
  };
}

function createCaptureStream(store: string[]): CaptureStream {
  return {
    write(chunk: string) {
      store.push(chunk);
      return true;
    },
  };
}

function createStdin(isTTY = false): NodeJS.ReadStream {
  return { isTTY } as NodeJS.ReadStream;
}

function runGit(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return stdout.trim();
}

async function writePlugin(
  directory: string,
  pluginId: string,
  roleLines: string[] = ["  - default"],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "manifest.yaml"),
    [
      `id: ${pluginId}`,
      `name: ${pluginId} plugin`,
      "version: 1.0.0",
      "command: echo",
      "roles:",
      ...roleLines,
    ].join("\n"),
  );
  await writeFile(join(directory, "adapter.ts"), "export default {};\n");
  await mkdir(join(directory, "prompts"), { recursive: true });
  await writeFile(
    join(directory, "prompts", "default.txt"),
    "default prompt\n",
  );
}

async function createGitRepository(
  layout: (repoDirectory: string) => Promise<void>,
): Promise<string> {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), "bab-plugin-repo-"));

  await layout(repositoryDirectory);
  runGit(["init", "-b", "main"], repositoryDirectory);
  runGit(["config", "user.email", "bab@example.com"], repositoryDirectory);
  runGit(["config", "user.name", "Bab Tests"], repositoryDirectory);
  runGit(["add", "."], repositoryDirectory);
  runGit(["commit", "--allow-empty", "-m", "initial"], repositoryDirectory);

  return repositoryDirectory;
}

describe("source parser", () => {
  test("parses GitHub shorthand", () => {
    expect(parseSource("babmcp/plugins")).toEqual({
      kind: "github_shorthand",
      original: "babmcp/plugins",
      url: "https://github.com/babmcp/plugins.git",
    });
  });

  test("parses GitHub shorthand refs", () => {
    expect(parseSource("babmcp/plugins#v1.0")).toEqual({
      kind: "github_shorthand",
      original: "babmcp/plugins#v1.0",
      ref: "v1.0",
      url: "https://github.com/babmcp/plugins.git",
    });
  });

  test("passes through ssh URLs", () => {
    expect(parseSource("git@github.com:babmcp/plugins.git")).toEqual({
      kind: "git_url",
      original: "git@github.com:babmcp/plugins.git",
      url: "git@github.com:babmcp/plugins.git",
    });
  });

  test("passes through full URLs and preserves slash refs", () => {
    expect(
      parseSource("https://github.com/babmcp/plugins.git#feature/plugins"),
    ).toEqual({
      kind: "git_url",
      original: "https://github.com/babmcp/plugins.git#feature/plugins",
      ref: "feature/plugins",
      url: "https://github.com/babmcp/plugins.git",
    });
  });

  test("rejects empty and local sources", () => {
    expect(() => parseSource("")).toThrow("Plugin source must not be empty");
    expect(() => parseSource("./plugins")).toThrow(
      "Local plugin sources are not supported",
    );
  });

  test("rejects insecure http:// sources", () => {
    expect(() => parseSource("http://example.com/repo.git")).toThrow(
      "Insecure http:// plugin sources are not allowed",
    );
  });

  test("rejects git sources that could be parsed as clone options", () => {
    expect(() => parseSource("--upload-pack=sh@example.com:repo.git")).toThrow(
      'Plugin source URL must not start with "-"',
    );
  });
});

describe("plugin install command", () => {
  test("installs a root-level plugin repo and writes metadata", async () => {
    const repositoryDirectory = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(repoDirectory, "claude");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-target-"));
    const stdout: string[] = [];
    const tempParent = await mkdtemp(
      join(tmpdir(), "bab-install-temp-parent-"),
    );

    const summaries = await installPluginsFromSource({
      config: createConfig(pluginsDir),
      isTty: false,
      source: {
        kind: "git_url",
        original: "git@github.com:babmcp/plugins.git",
        url: `file://${repositoryDirectory}`,
      },
      stderr: createCaptureStream([]),
      stdin: createStdin(false),
      stdout: createCaptureStream(stdout),
      tempDirectoryParent: tempParent,
      yes: true,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe("claude");
    expect(stdout.join("")).toContain("claude plugin");

    const installDirectory = join(pluginsDir, "claude");
    const metadata = JSON.parse(
      await readFile(join(installDirectory, ".install.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(metadata.plugin_id).toBe("claude");
    expect(metadata.plugin_subdir).toBe(".");
    expect(metadata.source_original).toBe("git@github.com:babmcp/plugins.git");
    expect(metadata.source_url).toBe(`file://${repositoryDirectory}`);
    expect(await readdir(tempParent)).toEqual([]);
  });

  test("installs multi-plugin repositories from immediate child directories", async () => {
    const repositoryDirectory = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(join(repoDirectory, "claude"), "claude");
        await writePlugin(join(repoDirectory, "codex"), "codex");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-multi-"));

    const summaries = await installPluginsFromSource({
      config: createConfig(pluginsDir),
      isTty: false,
      source: {
        kind: "git_url",
        original: "git@github.com:babmcp/plugins.git",
        url: `file://${repositoryDirectory}`,
      },
      stderr: createCaptureStream([]),
      stdin: createStdin(false),
      stdout: createCaptureStream([]),
      yes: true,
    });

    expect(summaries.map((item) => item.id)).toEqual(["claude", "codex"]);

    const codexMetadata = JSON.parse(
      await readFile(join(pluginsDir, "codex", ".install.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(codexMetadata.plugin_subdir).toBe("codex");
  });

  test("fails when no plugin manifests are found", async () => {
    const repositoryDirectory = await createGitRepository(async () => {});
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-none-"));

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${repositoryDirectory}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow("No plugins found in repository");
  });

  test("fails on ambiguous root and child manifests", async () => {
    const repositoryDirectory = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(repoDirectory, "claude");
        await writePlugin(join(repoDirectory, "codex"), "codex");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-ambiguous-"));

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${repositoryDirectory}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow("Repository layout is ambiguous");
  });

  test("rejects invalid manifests and duplicate plugin ids", async () => {
    const invalidRepository = await createGitRepository(
      async (repoDirectory) => {
        await mkdir(join(repoDirectory, "broken"), { recursive: true });
        await writeFile(
          join(repoDirectory, "broken", "manifest.yaml"),
          "id: broken\n",
        );
      },
    );
    const duplicateRepository = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(join(repoDirectory, "one"), "claude");
        await writePlugin(join(repoDirectory, "two"), "claude");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-errors-"));

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${invalidRepository}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow();

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${duplicateRepository}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow('Repository contains duplicate plugin id "claude"');
  });

  test("rejects bundled and already-installed plugin id conflicts", async () => {
    const bundledConflictRepository = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(repoDirectory, "opencode");
      },
    );
    const installedConflictRepository = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(repoDirectory, "claude");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-conflicts-"));

    await mkdir(join(pluginsDir, "claude"), { recursive: true });
    await writeFile(
      join(pluginsDir, "claude", "manifest.yaml"),
      "id: claude\n",
    );

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${bundledConflictRepository}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow('Plugin id "opencode" conflicts with a bundled plugin');

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${installedConflictRepository}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: true,
      }),
    ).rejects.toThrow('Plugin "claude" is already installed');
  });

  test("requires confirmation without --yes in non-interactive mode", async () => {
    const repositoryDirectory = await createGitRepository(
      async (repoDirectory) => {
        await writePlugin(repoDirectory, "claude");
      },
    );
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-install-confirm-"));

    await expect(
      installPluginsFromSource({
        config: createConfig(pluginsDir),
        isTty: false,
        source: {
          kind: "git_url",
          original: "git@github.com:babmcp/plugins.git",
          url: `file://${repositoryDirectory}`,
        },
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
        yes: false,
      }),
    ).rejects.toThrow("Confirmation required in non-interactive mode");
  });

  test.skipIf(process.getuid?.() === 0)(
    "cleans up staging failures without partial installs",
    async () => {
      const repositoryDirectory = await createGitRepository(
        async (repoDirectory) => {
          await writePlugin(repoDirectory, "claude");
        },
      );
      const pluginsDir = await mkdtemp(
        join(tmpdir(), "bab-install-stage-failure-"),
      );
      const originalMode = (await stat(pluginsDir)).mode;

      await chmod(pluginsDir, 0o500);

      try {
        await expect(
          installPluginsFromSource({
            config: createConfig(pluginsDir),
            isTty: false,
            source: {
              kind: "git_url",
              original: "git@github.com:babmcp/plugins.git",
              url: `file://${repositoryDirectory}`,
            },
            stderr: createCaptureStream([]),
            stdin: createStdin(false),
            stdout: createCaptureStream([]),
            yes: true,
          }),
        ).rejects.toThrow();
      } finally {
        await chmod(pluginsDir, originalMode & 0o777);
      }

      expect(await readdir(pluginsDir)).toEqual([]);
    },
  );
});

describe("command wrappers", () => {
  test("runAddCommand rejects local sources before invoking git", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-command-add-"));

    await expect(
      runAddCommand(["--yes", "./plugins"], {
        config: createConfig(pluginsDir),
        isTty: false,
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
      }),
    ).rejects.toThrow("Local plugin sources are not supported");
  });

  test("runRemoveCommand removes installed plugins and refuses bundled ones", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-command-remove-"));
    const pluginDirectory = join(pluginsDir, "claude");

    await writePlugin(pluginDirectory, "claude");

    const exitCode = await runRemoveCommand(["claude", "--yes"], {
      config: createConfig(pluginsDir),
      isTty: false,
      stderr: createCaptureStream([]),
      stdin: createStdin(false),
      stdout: createCaptureStream([]),
    });

    expect(exitCode).toBe(0);
    expect(await stat(pluginDirectory).catch(() => undefined)).toBeUndefined();

    await expect(
      runRemoveCommand(["opencode", "--yes"], {
        config: createConfig(pluginsDir),
        isTty: false,
        stderr: createCaptureStream([]),
        stdin: createStdin(false),
        stdout: createCaptureStream([]),
      }),
    ).rejects.toThrow("cannot remove bundled plugin");
  });

  test("runListCommand prints bundled and installed plugins", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "bab-command-list-"));
    const pluginDirectory = join(pluginsDir, "claude");
    const stdout: string[] = [];

    await writePlugin(pluginDirectory, "claude");
    await writeFile(
      join(pluginDirectory, ".install.json"),
      JSON.stringify({
        installed_at: "2026-03-10T17:00:00Z",
        installer_version: "0.1.0",
        manifest_name: "claude plugin",
        manifest_version: "1.0.0",
        plugin_id: "claude",
        plugin_subdir: ".",
        resolved_commit: "abc123",
        schema_version: 1,
        source_original: "git@github.com:babmcp/plugins.git",
        source_url: "git@github.com:babmcp/plugins.git",
      }),
    );

    const exitCode = await runListCommand([], {
      config: createConfig(pluginsDir),
      stdout: createCaptureStream(stdout),
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("claude");
    expect(stdout.join("")).toContain("opencode");
    expect(stdout.join("")).toContain("git@github.com:babmcp/plugins.git");
  });

  test("runListCommand marks plugins as disabled when CLI command is missing on PATH", async () => {
    const pluginsDir = await mkdtemp(
      join(tmpdir(), "bab-command-list-disabled-"),
    );
    const missingCliPluginDir = join(pluginsDir, "ghost");
    const echoPluginDir = join(pluginsDir, "real");
    const stdout: string[] = [];

    await writePlugin(echoPluginDir, "real");
    await mkdir(missingCliPluginDir, { recursive: true });
    await writeFile(
      join(missingCliPluginDir, "manifest.yaml"),
      [
        "id: ghost",
        "name: ghost plugin",
        "version: 1.0.0",
        "command: __definitely-not-on-path-xyz__",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(
      join(missingCliPluginDir, "adapter.ts"),
      "export default {};\n",
    );
    await mkdir(join(missingCliPluginDir, "prompts"), { recursive: true });
    await writeFile(
      join(missingCliPluginDir, "prompts", "default.txt"),
      "ghost prompt\n",
    );

    const exitCode = await runListCommand([], {
      config: createConfig(pluginsDir),
      stdout: createCaptureStream(stdout),
    });

    const output = stdout.join("");
    expect(exitCode).toBe(0);
    expect(output).toContain("disabled");
    expect(output).toContain("__definitely-not-on-path-xyz__");
    expect(output).toContain("not found on PATH");
    expect(output).toContain("active");
  });

  test("getBundledPluginsRoot resolves from a compiled-binary layout", async () => {
    const bundledRoot = await getBundledPluginsRoot([
      join(process.cwd(), "dist"),
    ]);

    expect(bundledRoot).toBe(join(process.cwd(), "plugins"));
  });
});

import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDependencies, getCliHelpText, runCli } from "../src/cli";
import type { BabConfig } from "../src/config";
import { validatePluginDirectory } from "../src/plugin-sdk/conformance";
import { VERSION } from "../src/version";

const TEST_CONFIG: BabConfig = {
  env: {},
  paths: {
    baseDir: "/tmp/.config/bab",
    envFile: "/tmp/.config/bab/env",
    pluginsDir: "/tmp/.config/bab/plugins",
    promptsDir: "/tmp/.config/bab/prompts",
  },
};

function createCliDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies & { stderrWrites: string[]; stdoutWrites: string[] } {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  return {
    loadConfig: async () => TEST_CONFIG,
    runAddCommand: async () => 0,
    runConfigCommand: async () => 0,
    runListCommand: async () => 0,
    runOnboardCommand: async () => 0,
    runRemoveCommand: async () => 0,
    startServer: async () => {},
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stderr: {
      write(chunk: string) {
        stderrWrites.push(chunk);
        return true;
      },
    },
    stderrWrites,
    stdout: {
      write(chunk: string) {
        stdoutWrites.push(chunk);
        return true;
      },
    },
    stdoutWrites,
    validatePluginDirectory,
    ...overrides,
  };
}

function currentProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

describe("CLI", () => {
  test("shows help text", () => {
    expect(getCliHelpText()).toContain("Bab CLI v");
    expect(getCliHelpText()).toContain("MCP server, plugins, and CLI tools.");
    expect(getCliHelpText()).toContain("bab add <source>");
    expect(getCliHelpText()).toContain("bab --version");
  });

  test("starts the server when no command is provided", async () => {
    const startServer = mock(async () => {});
    const dependencies = createCliDependencies({ startServer });

    const exitCode = await runCli([], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  test("prints the version without starting the server", async () => {
    const startServer = mock(async () => {});
    const dependencies = createCliDependencies({ startServer });

    const exitCode = await runCli(["--version"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(dependencies.stdoutWrites.join("")).toContain(VERSION);
  });

  test("prints add help without starting the server", async () => {
    const startServer = mock(async () => {});
    const dependencies = createCliDependencies({ startServer });

    const exitCode = await runCli(["add", "--help"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(dependencies.stdoutWrites.join("")).toContain(
      "bab add <source> [--yes]",
    );
  });

  test("delegates add commands without starting the server", async () => {
    const startServer = mock(async () => {});
    const runAddCommand = mock(async () => 0);
    const dependencies = createCliDependencies({ runAddCommand, startServer });

    const exitCode = await runCli(["add", "babmcp/plugins"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(runAddCommand).toHaveBeenCalledTimes(1);
  });

  test("returns a nonzero exit code for unknown commands", async () => {
    const dependencies = createCliDependencies();

    const exitCode = await runCli(["unknown"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.stderrWrites.join("")).toContain(
      "Unknown command: unknown",
    );
    expect(dependencies.stderrWrites.join("")).toContain("Bab CLI");
  });

  test("delegates onboard commands without starting the server", async () => {
    const startServer = mock(async () => {});
    const runOnboardCommand = mock(async () => 0);
    const dependencies = createCliDependencies({
      runOnboardCommand,
      startServer,
    });

    const exitCode = await runCli(["onboard"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(runOnboardCommand).toHaveBeenCalledTimes(1);
  });

  test("passes --agent flag through to onboard command", async () => {
    let receivedArgs: string[] = [];
    const runOnboardCommand = mock(async (args: string[]) => {
      receivedArgs = args;
      return 0;
    });
    const dependencies = createCliDependencies({ runOnboardCommand });

    const exitCode = await runCli(
      ["onboard", "--agent", "claude"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(runOnboardCommand).toHaveBeenCalledTimes(1);
    expect(receivedArgs).toEqual(["--agent", "claude"]);
  });

  test("prints onboard help without starting the server", async () => {
    const startServer = mock(async () => {});
    const dependencies = createCliDependencies({ startServer });

    const exitCode = await runCli(["onboard", "--help"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(dependencies.stdoutWrites.join("")).toContain(
      "bab onboard [--agent <name>]",
    );
  });

  test("delegates list commands without starting the server", async () => {
    const startServer = mock(async () => {});
    const runListCommand = mock(async () => 0);
    const dependencies = createCliDependencies({ runListCommand, startServer });

    const exitCode = await runCli(["list"], dependencies);

    expect(exitCode).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
    expect(runListCommand).toHaveBeenCalledTimes(1);
  });

  test("validates a plugin directory through the conformance command", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "bab-cli-plugin-"));
    const pluginDirectory = join(pluginRoot, "echo");

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
        "      type: 'done',",
        "      run_id: input.runId,",
        "      provider_id: 'echo',",
        "      timestamp: new Date().toISOString(),",
        "      metadata: {},",
        "    }];",
        "  },",
        "};",
      ].join("\n"),
    );

    const dependencies = createCliDependencies();

    const exitCode = await runCli(
      ["test-plugin", pluginDirectory],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.stdoutWrites.join("")).toContain('"valid": true');
  });

  test("compiled binary lists bundled plugins when available", async () => {
    const binaryPath = join(process.cwd(), "dist", "bab");
    const binaryExists = await stat(binaryPath)
      .then(() => true)
      .catch(() => false);

    // This is a packaging smoke test, so skip quietly when the binary
    // has not been built for the current checkout.
    if (!binaryExists) {
      return;
    }

    const result = Bun.spawnSync([binaryPath, "list"], {
      cwd: process.cwd(),
      env: currentProcessEnv(),
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("opencode");
  });
});

describe("plugin conformance", () => {
  test("reports a missing manifest", async () => {
    const missingDirectory = await mkdtemp(
      join(tmpdir(), "bab-missing-plugin-"),
    );
    const result = await validatePluginDirectory(missingDirectory);

    expect(result.valid).toBeFalse();
    expect(result.issues[0]).toContain("Missing manifest.yaml");
  });
});

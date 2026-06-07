import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvFile } from "../src/config";
import { loadPlugin, loadPlugins } from "../src/delegate/loader";
import { mergeEnv, readPluginEnv } from "../src/utils/env";

describe("env utilities", () => {
  test("parseEnvFile reports malformed lines with a filename and line number", () => {
    expect(() =>
      parseEnvFile("BROKEN LINE", { source: "/tmp/example.env" }),
    ).toThrow("/tmp/example.env: line 1: expected KEY=VALUE assignment");
  });

  test("readPluginEnv returns an empty map when the env file is missing", async () => {
    const pluginDirectory = await mkdtemp(
      join(tmpdir(), "bab-plugin-env-missing-"),
    );

    expect(await readPluginEnv(pluginDirectory)).toEqual({});
  });

  test("readPluginEnv accepts duplicate keys and empty values", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-plugin-env-"));

    await writeFile(
      join(pluginDirectory, "env"),
      ["FOO=one", "FOO=two", "EMPTY="].join("\n"),
    );

    expect(await readPluginEnv(pluginDirectory)).toEqual({
      EMPTY: "",
      FOO: "two",
    });
  });

  test("mergeEnv applies precedence and denylists file-based overrides", () => {
    const processEnv = {
      GLOBAL_ONLY: "process",
      PATH: "/usr/bin",
      SHARED: "process",
    };
    const globalEnv = {
      GLOBAL_ONLY: "global",
      PATH: "/blocked-global",
      SHARED: "global",
    };
    const pluginEnv = {
      BAB_PLUGIN_PRIVATE: "plugin-blocked",
      PATH: "/blocked-plugin",
      PLUGIN_ONLY: "plugin",
      SHARED: "plugin",
    };

    const merged = mergeEnv(processEnv, globalEnv, pluginEnv);

    expect(merged.BAB_PLUGIN_PRIVATE).toBeUndefined();
    expect(merged.GLOBAL_ONLY).toBe("global");
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.PLUGIN_ONLY).toBe("plugin");
    expect(merged.SHARED).toBe("plugin");
    expect(globalEnv.PATH).toBe("/blocked-global");
    expect(pluginEnv.PATH).toBe("/blocked-plugin");
  });

  test("mergeEnv strips BAB_* and API keys from process env", () => {
    const processEnv = {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      GOOGLE_API_KEY: "google-secret",
      GEMINI_API_KEY: "gemini-secret",
      OPENROUTER_API_KEY: "or-secret",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "ghp_secret2",
      BAB_LOG_LEVEL: "debug",
      BAB_LAZY_TOOLS: "1",
      SAFE_VAR: "keep-me",
    };

    const merged = mergeEnv(processEnv, {}, {});

    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
    expect(merged.OPENAI_API_KEY).toBeUndefined();
    expect(merged.GOOGLE_API_KEY).toBeUndefined();
    expect(merged.GEMINI_API_KEY).toBeUndefined();
    expect(merged.OPENROUTER_API_KEY).toBeUndefined();
    expect(merged.GITHUB_TOKEN).toBeUndefined();
    expect(merged.GH_TOKEN).toBeUndefined();
    expect(merged.BAB_LOG_LEVEL).toBeUndefined();
    expect(merged.BAB_LAZY_TOOLS).toBeUndefined();
    expect(merged.SAFE_VAR).toBe("keep-me");
  });

  test("mergeEnv strips dangerous process env vars from delegate env", () => {
    const processEnv = {
      HOME: "/home/user",
      LD_PRELOAD: "/evil/lib.so",
      DYLD_INSERT_LIBRARIES: "/evil/lib.dylib",
      NODE_OPTIONS: "--require /evil/hook.js",
      SAFE_VAR: "keep-me",
    };

    const merged = mergeEnv(processEnv, {}, {});

    expect(merged.LD_PRELOAD).toBeUndefined();
    expect(merged.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(merged.NODE_OPTIONS).toBeUndefined();
    expect(merged.SAFE_VAR).toBe("keep-me");
  });

  test("mergeEnv strips common secret patterns from process env", () => {
    const processEnv = {
      XAI_API_KEY: "xai-secret",
      AZURE_OPENAI_API_KEY: "azure-secret",
      NPM_TOKEN: "npm-secret",
      PYPI_TOKEN: "pypi-secret",
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "session-token",
      DOCKER_PASSWORD: "docker-pass",
      MYAPP_CLIENT_SECRET: "client-secret",
      MYAPP_API_SECRET: "api-secret",
      SAFE_VAR: "keep-me",
      MYAPP_MODE: "production",
    };

    const merged = mergeEnv(processEnv, {}, {});

    expect(merged.XAI_API_KEY).toBeUndefined();
    expect(merged.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(merged.NPM_TOKEN).toBeUndefined();
    expect(merged.PYPI_TOKEN).toBeUndefined();
    expect(merged.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(merged.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(merged.AWS_SESSION_TOKEN).toBeUndefined();
    expect(merged.DOCKER_PASSWORD).toBeUndefined();
    expect(merged.MYAPP_CLIENT_SECRET).toBeUndefined();
    expect(merged.MYAPP_API_SECRET).toBeUndefined();
    expect(merged.SAFE_VAR).toBe("keep-me");
    expect(merged.MYAPP_MODE).toBe("production");
  });

  test("mergeEnv does not mutate the object returned by currentProcessEnv", () => {
    const { currentProcessEnv } = require("../src/utils/env");
    const original = currentProcessEnv({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      SAFE_VAR: "keep-me",
    });
    const snapshot = { ...original };

    mergeEnv(
      { ANTHROPIC_API_KEY: "sk-ant-secret", SAFE_VAR: "keep-me" },
      {},
      {},
    );

    expect(original).toEqual(snapshot);
    expect(original.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
  });

  test("mergeEnv strips global config secrets while preserving explicit plugin secrets", () => {
    const merged = mergeEnv(
      {
        PATH: "/usr/bin",
        SAFE_PROCESS: "process",
      },
      {
        BAB_LOG_LEVEL: "debug",
        GITHUB_TOKEN: "global-token",
        GLOBAL_ONLY: "global",
        MYAPP_CLIENT_SECRET: "global-secret",
        OPENAI_API_KEY: "global-openai",
      },
      {
        OPENAI_API_KEY: "plugin-openai",
        PLUGIN_ONLY: "plugin",
      },
    );

    expect(merged.BAB_LOG_LEVEL).toBeUndefined();
    expect(merged.GITHUB_TOKEN).toBeUndefined();
    expect(merged.MYAPP_CLIENT_SECRET).toBeUndefined();
    expect(merged.GLOBAL_ONLY).toBe("global");
    expect(merged.OPENAI_API_KEY).toBe("plugin-openai");
    expect(merged.PLUGIN_ONLY).toBe("plugin");
    expect(merged.SAFE_PROCESS).toBe("process");
  });
});

describe("delegate loader env integration", () => {
  test("loadPlugin includes parsed plugin env on the internal record", async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), "bab-loader-env-"));

    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: echo-env",
        "name: Echo Env",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(join(pluginDirectory, "env"), "PLUGIN_TOKEN=secret\n");

    const loaded = await loadPlugin({
      directory: pluginDirectory,
      manifestPath: join(pluginDirectory, "manifest.yaml"),
    });

    expect(loaded.env).toEqual({
      PLUGIN_TOKEN: "secret",
    });
  });

  test("loadPlugins skips plugins with malformed env files", async () => {
    const pluginsRoot = await mkdtemp(join(tmpdir(), "bab-loader-bad-env-"));
    const pluginDirectory = join(pluginsRoot, "broken");

    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      join(pluginDirectory, "manifest.yaml"),
      [
        "id: broken-env",
        "name: Broken Env",
        "version: 1.0.0",
        "command: echo",
        "roles:",
        "  - default",
      ].join("\n"),
    );
    await writeFile(join(pluginDirectory, "env"), "BROKEN LINE\n");

    const loaded = await loadPlugins([
      {
        directory: pluginDirectory,
        manifestPath: join(pluginDirectory, "manifest.yaml"),
      },
    ]);

    expect(loaded).toHaveLength(0);
  });
});

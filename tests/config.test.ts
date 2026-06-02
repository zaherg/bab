import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureConfigDirectories,
  getConfigPaths,
  loadConfig,
  parseEnvFile,
} from "../src/config";

describe("config paths", () => {
  test("uses ~/.config/bab under the provided home directory", () => {
    const paths = getConfigPaths("/tmp/example-home");

    expect(paths.baseDir).toBe("/tmp/example-home/.config/bab");
    expect(paths.envFile).toBe("/tmp/example-home/.config/bab/env");
    expect(paths.pluginsDir).toBe("/tmp/example-home/.config/bab/plugins");
    expect(paths.promptsDir).toBe("/tmp/example-home/.config/bab/prompts");
  });

  test("creates the config, plugins, and prompts directories", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "bab-config-home-"));
    const paths = await ensureConfigDirectories(getConfigPaths(homeDirectory));

    expect((await stat(paths.baseDir)).isDirectory()).toBeTrue();
    expect((await stat(paths.pluginsDir)).isDirectory()).toBeTrue();
    expect((await stat(paths.promptsDir)).isDirectory()).toBeTrue();
  });
});

describe("config env parsing", () => {
  test("parses dotenv-style lines with export support", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "OPENAI_API_KEY=test-key",
          "export CUSTOM_API_URL='https://example.com'",
        ].join("\n"),
      ),
    ).toEqual({
      CUSTOM_API_URL: "https://example.com",
      OPENAI_API_KEY: "test-key",
    });
  });

  test("loads BAB_* config from ~/.config/bab/env", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "bab-config-env-"));
    const paths = await ensureConfigDirectories(getConfigPaths(homeDirectory));

    await writeFile(
      paths.envFile,
      ["BAB_EAGER_TOOLS=1", "BAB_DISABLED_TOOLS=chat"].join("\n"),
    );

    const config = await loadConfig(homeDirectory);

    expect(config.lazyTools).toBeFalse();
    expect(config.env.BAB_DISABLED_TOOLS).toBe("chat");
  });
});

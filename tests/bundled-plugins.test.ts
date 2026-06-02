import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type BundledPlugin,
  extractBundledPlugins,
  readBundledPluginsFromDisk,
  renderBundledPluginsModule,
} from "../scripts/bundle-plugins";
import {
  BUNDLED_PLUGIN_IDS,
  getBundledPluginsRoot,
} from "../src/commands/shared";
import { discoverPluginDirectories } from "../src/delegate/discovery";

let workdir = "";
let pluginsRoot = "";

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "bab-bundle-"));
  pluginsRoot = join(workdir, "plugins");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function makePlugin(
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(pluginsRoot, id);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

describe("readBundledPluginsFromDisk", () => {
  test("returns one record per plugin subdirectory", async () => {
    await makePlugin("alpha", { "manifest.yaml": "id: alpha\n" });
    await makePlugin("beta", {
      "manifest.yaml": "id: beta\n",
      "adapter.ts": "export default { run: () => [] };",
    });

    const plugins = await readBundledPluginsFromDisk(pluginsRoot);
    const ids = plugins.map((p) => p.id).sort();

    expect(ids).toEqual(["alpha", "beta"]);
  });

  test("reads manifest content verbatim", async () => {
    const manifestContent = "id: alpha\nname: Alpha\nversion: 1.0.0\n";
    await makePlugin("alpha", { "manifest.yaml": manifestContent });

    const [plugin] = await readBundledPluginsFromDisk(pluginsRoot);

    expect(plugin).toBeDefined();
    expect(plugin?.manifestYaml).toBe(manifestContent);
  });

  test("includes adapter source when adapter.ts exists", async () => {
    const adapter = "export default { run: () => [] };\n";
    await makePlugin("alpha", {
      "manifest.yaml": "id: alpha\n",
      "adapter.ts": adapter,
    });

    const [plugin] = await readBundledPluginsFromDisk(pluginsRoot);

    expect(plugin?.adapterSource).toBe(adapter);
  });

  test("adapterSource is undefined when adapter.ts is absent", async () => {
    await makePlugin("alpha", { "manifest.yaml": "id: alpha\n" });

    const [plugin] = await readBundledPluginsFromDisk(pluginsRoot);

    expect(plugin?.adapterSource).toBeUndefined();
  });

  test("captures non-manifest/non-adapter files as extraFiles with relative paths", async () => {
    await makePlugin("alpha", {
      "manifest.yaml": "id: alpha\n",
      "prompts/default.txt": "you are alpha\n",
      "prompts/planner.txt": "you plan\n",
    });

    const [plugin] = await readBundledPluginsFromDisk(pluginsRoot);

    expect(plugin?.extraFiles).toEqual([
      { path: "prompts/default.txt", content: "you are alpha\n" },
      { path: "prompts/planner.txt", content: "you plan\n" },
    ]);
  });

  test("returns empty array when plugins root does not exist", async () => {
    const plugins = await readBundledPluginsFromDisk(join(workdir, "missing"));
    expect(plugins).toEqual([]);
  });
});

describe("renderBundledPluginsModule", () => {
  test("produces a module that exports bundledPlugins with the given records", () => {
    const plugins: BundledPlugin[] = [
      {
        adapterSource: "export default {};\n",
        extraFiles: [{ path: "prompts/a.txt", content: "a\n" }],
        id: "alpha",
        manifestYaml: "id: alpha\n",
      },
    ];

    const code = renderBundledPluginsModule(plugins);

    expect(code).toContain(
      'import type { BundledPlugin } from "../scripts/bundle-plugins"',
    );
    expect(code).toContain("export const bundledPlugins: BundledPlugin[] = [");
    expect(code).toContain('id: "alpha"');
  });

  test("escapes backticks and dollar-curly-brace inside embedded strings", () => {
    const plugins: BundledPlugin[] = [
      {
        adapterSource: undefined,
        extraFiles: [],
        id: "alpha",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} under test
        manifestYaml: "literal: `tick` and ${expr}\n",
      },
    ];

    const code = renderBundledPluginsModule(plugins);

    expect(code).toContain("\\`tick\\`");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} under test
    expect(code).toContain("\\${expr}");
  });
});

describe("extractBundledPlugins", () => {
  test("writes manifest, adapter, and extra files to <target>/<id>/", async () => {
    const target = join(workdir, "out");
    const plugins: BundledPlugin[] = [
      {
        adapterSource: "export default { run: () => [] };\n",
        extraFiles: [
          { path: "prompts/default.txt", content: "hi\n" },
          { path: "prompts/inner/deep.txt", content: "deep\n" },
        ],
        id: "alpha",
        manifestYaml: "id: alpha\n",
      },
    ];

    const extracted = await extractBundledPlugins(target, plugins);

    expect(extracted).toBe(target);
    expect(
      await readFile(join(extracted, "alpha", "manifest.yaml"), "utf8"),
    ).toBe("id: alpha\n");
    expect(await readFile(join(extracted, "alpha", "adapter.ts"), "utf8")).toBe(
      "export default { run: () => [] };\n",
    );
    expect(
      await readFile(join(extracted, "alpha", "prompts/default.txt"), "utf8"),
    ).toBe("hi\n");
    expect(
      await readFile(
        join(extracted, "alpha", "prompts/inner/deep.txt"),
        "utf8",
      ),
    ).toBe("deep\n");
  });

  test("returns the target root when there are no plugins", async () => {
    const target = join(workdir, "out");
    const extracted = await extractBundledPlugins(target, []);
    expect(extracted).toBe(target);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  test("is idempotent — second call does not rewrite unchanged files", async () => {
    const target = join(workdir, "out");
    const plugins: BundledPlugin[] = [
      {
        adapterSource: undefined,
        extraFiles: [],
        id: "alpha",
        manifestYaml: "id: alpha\n",
      },
    ];

    await extractBundledPlugins(target, plugins);
    const firstMtime = (await stat(join(target, "alpha", "manifest.yaml")))
      .mtimeMs;

    // Sleep a tick so mtime would differ if we rewrote
    await new Promise((r) => setTimeout(r, 25));

    await extractBundledPlugins(target, plugins);
    const secondMtime = (await stat(join(target, "alpha", "manifest.yaml")))
      .mtimeMs;

    expect(secondMtime).toBe(firstMtime);
  });
});

describe("bundled + installed coexistence", () => {
  test("discovery returns each plugin from its respective root", async () => {
    const bundledDir = join(workdir, "bundled");
    const installedDir = join(workdir, "installed");

    await makePlugin("bundled-only", { "manifest.yaml": "id: bundled-only\n" });
    await makePlugin("shared-name", { "manifest.yaml": "id: shared-name\n" });
    await extractBundledPlugins(bundledDir, [
      {
        adapterSource: undefined,
        extraFiles: [],
        id: "bundled-only",
        manifestYaml: "id: bundled-only\n",
      },
    ]);

    // The installed dir has its own plugin, plus a same-id-as-bundled one
    // (which the add command would reject, but discovery tolerates it).
    await mkdir(join(installedDir, "installed-only"), { recursive: true });
    await writeFile(
      join(installedDir, "installed-only", "manifest.yaml"),
      "id: installed-only\n",
    );
    await mkdir(join(installedDir, "shared-name"), { recursive: true });
    await writeFile(
      join(installedDir, "shared-name", "manifest.yaml"),
      "id: shared-name\n",
    );

    const bundled = await discoverPluginDirectories(bundledDir);
    const installed = await discoverPluginDirectories(installedDir);

    expect(bundled.map((p) => p.directory).sort()).toEqual([
      join(bundledDir, "bundled-only"),
    ]);
    expect(installed.map((p) => p.directory).sort()).toEqual([
      join(installedDir, "installed-only"),
      join(installedDir, "shared-name"),
    ]);
  });

  test("BUNDLED_PLUGIN_IDS still contains the canonical bundled id", () => {
    // The add command uses this static list to reject id collisions with
    // bundled plugins at install time, so the list must stay in sync with
    // whatever ships embedded in the binary.
    expect(BUNDLED_PLUGIN_IDS).toContain("opencode");
  });
});

describe("getBundledPluginsRoot env override", () => {
  test("respects BAB_BUNDLED_PLUGINS_DIR when walking up fails", async () => {
    // Create a fake "bundled" target with a manifest
    const target = join(workdir, "forced");
    await mkdir(join(target, "opencode"), { recursive: true });
    await writeFile(
      join(target, "opencode", "manifest.yaml"),
      "id: opencode\n",
    );

    const previous = process.env.BAB_BUNDLED_PLUGINS_DIR;
    process.env.BAB_BUNDLED_PLUGINS_DIR = target;
    try {
      // Pass search roots that do not exist so the walk-up algorithm
      // cannot accidentally find anything and the embedded extraction
      // path becomes the only option.
      const nonExistent = join(workdir, "no-such-search-root");
      const root = await getBundledPluginsRoot([nonExistent]);
      expect(root).toBe(target);
    } finally {
      if (previous === undefined) {
        delete process.env.BAB_BUNDLED_PLUGINS_DIR;
      } else {
        process.env.BAB_BUNDLED_PLUGINS_DIR = previous;
      }
    }
  });
});

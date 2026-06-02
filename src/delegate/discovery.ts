import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoveredPlugin } from "./types";

export async function discoverPluginDirectories(
  pluginsDirectory: string,
): Promise<DiscoveredPlugin[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(pluginsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const realPluginsRoot = await realpath(pluginsDirectory);
  const discoveredPlugins: DiscoveredPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(pluginsDirectory, entry.name);

    const realDirectory = await realpath(directory);
    if (
      realDirectory !== realPluginsRoot &&
      !realDirectory.startsWith(`${realPluginsRoot}/`)
    ) {
      continue;
    }
    const manifestPath = join(directory, "manifest.yaml");
    const adapterPath = join(directory, "adapter.ts");

    try {
      const manifestStats = await stat(manifestPath);

      if (!manifestStats.isFile()) {
        continue;
      }

      const hasAdapter = await stat(adapterPath)
        .then((adapterStats) => adapterStats.isFile())
        .catch(() => false);

      discoveredPlugins.push({
        adapterPath: hasAdapter ? adapterPath : undefined,
        directory,
        manifestPath,
      });
    } catch {}
  }

  return discoveredPlugins.sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
}

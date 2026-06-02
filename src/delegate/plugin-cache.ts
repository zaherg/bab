import { getBundledPluginsRoot } from "../commands/shared";
import type { BabConfig } from "../config";
import { discoverPluginDirectories } from "./discovery";
import { loadPlugins } from "./loader";
import type { DiscoveredPlugin, LoadedPlugin } from "./types";

const PLUGIN_CACHE_TTL_MS = 5_000;

type LoadedPluginWithEnv = LoadedPlugin & { env: Record<string, string> };

let inflight: Promise<LoadedPluginWithEnv[]> | undefined;
let cached:
  | {
      loaded: LoadedPluginWithEnv[];
      at: number;
    }
  | undefined;

async function discoverAndLoad(
  config: BabConfig,
): Promise<LoadedPluginWithEnv[]> {
  const bundledRoot = await getBundledPluginsRoot();
  const [bundled, installed] = await Promise.all([
    discoverPluginDirectories(bundledRoot),
    discoverPluginDirectories(config.paths.pluginsDir),
  ]);
  const markSource = (
    plugins: DiscoveredPlugin[],
    sourceType: "bundled" | "installed",
  ): DiscoveredPlugin[] => plugins.map((plugin) => ({ ...plugin, sourceType }));

  const allLoaded = await loadPlugins([
    ...markSource(bundled, "bundled"),
    ...markSource(installed, "installed"),
  ]);
  const byId = new Map(allLoaded.map((p) => [p.manifest.id, p]));
  return [...byId.values()];
}

export async function getLoadedPlugins(
  config: BabConfig,
): Promise<LoadedPluginWithEnv[]> {
  if (cached && Date.now() - cached.at < PLUGIN_CACHE_TTL_MS) {
    return cached.loaded;
  }

  if (inflight) {
    return inflight;
  }

  inflight = discoverAndLoad(config)
    .then((loaded) => {
      cached = { loaded, at: Date.now() };
      inflight = undefined;
      return loaded;
    })
    .catch((err: unknown) => {
      inflight = undefined;
      throw err;
    });

  return inflight;
}

export function invalidatePluginCache(): void {
  cached = undefined;
  inflight = undefined;
}

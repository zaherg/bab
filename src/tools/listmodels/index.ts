import { z } from "zod/v4";

import type { BabConfig } from "../../config";
import { getLoadedPlugins } from "../../delegate/plugin-cache";
import type { ProviderRegistry } from "../../providers/registry";
import type { RegisteredTool } from "../../server";

export function createListModelsTool(
  providerRegistry: ProviderRegistry,
  config: BabConfig,
): RegisteredTool {
  return {
    description:
      "List all available model IDs for use with other tools. " +
      "Shows SDK models (direct IDs like 'gpt-5.2', 'gemini-2.5-pro') and " +
      "plugin models (use as 'pluginId/modelName', e.g. 'copilot/claude-sonnet-4'). " +
      "Call this before using model-dependent tools like chat, consensus, or analyze.",
    execute: async () => {
      const providerModels = await providerRegistry.listModels();

      const plugins = await getLoadedPlugins(config);

      const pluginModels: Record<string, string[]> = {};

      const modelResults = await Promise.all(
        plugins
          .filter((p) => p.adapter?.listModels)
          .map(async (plugin) => {
            try {
              const models = await plugin.adapter?.listModels?.();
              return { id: plugin.manifest.id, models };
            } catch {
              return { id: plugin.manifest.id, models: [] as string[] };
            }
          }),
      );

      for (const { id, models } of modelResults) {
        if (models.length > 0) {
          pluginModels[id] = models;
        }
      }

      const result = {
        providers: providerModels,
        plugins: pluginModels,
      };

      const totalCount =
        providerModels.length +
        Object.values(pluginModels).reduce((sum, m) => sum + m.length, 0);

      return {
        ok: true,
        value: {
          content: JSON.stringify(result),
          content_type: "json",
          metadata: {
            count: totalCount,
            provider_count: providerModels.length,
            plugin_count: Object.keys(pluginModels).length,
          },
          status: "success",
        },
      };
    },
    inputSchema: z.object({}),
    name: "list_models",
  };
}

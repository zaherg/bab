import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { loadPlugin } from "../delegate/loader";

export interface PluginConformanceResult {
  adapter_present: boolean;
  command: string;
  delegate_api_version: number;
  directory: string;
  issues: string[];
  plugin_id: string;
  roles: string[];
  valid: boolean;
  version: string;
}

export async function validatePluginDirectory(
  pluginDirectory: string,
): Promise<PluginConformanceResult> {
  const resolvedDirectory = isAbsolute(pluginDirectory)
    ? pluginDirectory
    : resolve(pluginDirectory);
  const manifestPath = join(resolvedDirectory, "manifest.yaml");
  const adapterPath = join(resolvedDirectory, "adapter.ts");
  const issues: string[] = [];

  const manifestExists = await stat(manifestPath)
    .then((entry) => entry.isFile())
    .catch(() => false);

  if (!manifestExists) {
    return {
      adapter_present: false,
      command: "",
      delegate_api_version: 0,
      directory: resolvedDirectory,
      issues: [`Missing manifest.yaml in ${resolvedDirectory}`],
      plugin_id: "",
      roles: [],
      valid: false,
      version: "",
    };
  }

  const adapterExists = await stat(adapterPath)
    .then((entry) => entry.isFile())
    .catch(() => false);

  try {
    const loadedPlugin = await loadPlugin({
      adapterPath: adapterExists ? adapterPath : undefined,
      directory: resolvedDirectory,
      manifestPath,
      sourceType: "bundled",
    });

    if (!loadedPlugin.adapter) {
      issues.push("adapter.ts is missing or does not export a valid adapter");
    }

    return {
      adapter_present: Boolean(loadedPlugin.adapter),
      command: loadedPlugin.manifest.command,
      delegate_api_version: loadedPlugin.manifest.delegate_api_version,
      directory: resolvedDirectory,
      issues,
      plugin_id: loadedPlugin.manifest.id,
      roles: loadedPlugin.manifest.roles.map((role) =>
        typeof role === "string" ? role : role.name,
      ),
      valid: issues.length === 0,
      version: loadedPlugin.manifest.version,
    };
  } catch (error) {
    return {
      adapter_present: adapterExists,
      command: "",
      delegate_api_version: 0,
      directory: resolvedDirectory,
      issues: [error instanceof Error ? error.message : String(error)],
      plugin_id: "",
      roles: [],
      valid: false,
      version: "",
    };
  }
}

import type { BabConfig } from "../config";
import {
  PROVIDER_ENV_CONFIG,
  providerEnvVarNames,
} from "../providers/registry";
import type { ProviderId } from "../types";
import { SECRET_SUFFIXES } from "../utils/env";
import { VERSION } from "../version";
import {
  discoverBundledPluginRecords,
  discoverInstalledPluginRecords,
  formatTable,
  sourceLabel,
  type CommandPluginRecord,
  type WritableLike,
  writeLine,
} from "./shared";

interface ConfigCommandContext {
  config: BabConfig;
  stdout: WritableLike;
}

function maskValue(value: string): string {
  if (value.length <= 6) {
    return "***";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isSensitiveKey(key: string): boolean {
  return SECRET_SUFFIXES.some((sfx) => key.endsWith(sfx));
}

function sectionHeader(title: string): string {
  return `\n# ${title}`;
}

function renderBabInfo(config: BabConfig, indent = "  "): string {
  const lines = [
    sectionHeader("Bab"),
    `${indent}Version      ${VERSION}`,
    `${indent}Persistence  ${config.persistence?.enabled ? "on" : "off"}`,
    `${indent}Config Dir   ${config.paths.baseDir}`,
  ];

  return lines.join("\n");
}

interface DiscoveredPluginSets {
  bundled: CommandPluginRecord[];
  installed: CommandPluginRecord[];
}

async function discoverAllPlugins(
  config: BabConfig,
): Promise<DiscoveredPluginSets> {
  const [bundled, installed] = await Promise.all([
    discoverBundledPluginRecords().catch((): CommandPluginRecord[] => []),
    discoverInstalledPluginRecords(config.paths).catch(
      (): CommandPluginRecord[] => [],
    ),
  ]);
  return { bundled, installed };
}

function renderPlugins(plugins: DiscoveredPluginSets): string {
  const rows = [
    ["ID", "Name", "Version", "Command", "Source Type", "Source Repo"],
    ...[...plugins.bundled, ...plugins.installed]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map((plugin) => [
        plugin.manifest.id,
        plugin.manifest.name,
        plugin.manifest.version,
        plugin.manifest.command,
        plugin.sourceType,
        sourceLabel(plugin),
      ]),
  ];

  return [sectionHeader("Plugins"), formatTable(rows)].join("\n");
}

function isProviderConfigured(
  pid: ProviderId,
  env: Record<string, string>,
): boolean {
  const pc = PROVIDER_ENV_CONFIG[pid];

  if (pid === "custom") {
    return Boolean("baseUrl" in pc && pc.baseUrl && env[pc.baseUrl]);
  }

  return Boolean(pc.apiKey && env[pc.apiKey]);
}

function renderProviders(config: BabConfig, indent = "  "): string {
  const providers = Object.keys(PROVIDER_ENV_CONFIG) as ProviderId[];
  const env = config.env;

  const rows = providers.map((pid) => {
    const configured = isProviderConfigured(pid, env);
    const envKeys = providerEnvVarNames(pid);

    return `${indent}${pid.padEnd(12)} ${configured ? "configured" : "not configured"} (${envKeys.join(", ")})`;
  });

  return [sectionHeader("AI Providers"), ...rows].join("\n");
}

function getProviderEnvKeys(): Set<string> {
  const providers = Object.keys(PROVIDER_ENV_CONFIG) as ProviderId[];
  return new Set(providers.flatMap((pid) => providerEnvVarNames(pid)));
}

function isBabRelevant(key: string, providerKeys: Set<string>): boolean {
  if (key.startsWith("BAB_")) return true;

  return providerKeys.has(key);
}

function renderEnvironment(config: BabConfig, indent = "  "): string {
  const env = config.env;
  const providerKeys = getProviderEnvKeys();

  const keys = Object.keys(env)
    .filter((k) => isBabRelevant(k, providerKeys))
    .sort((left, right) => left.localeCompare(right));

  const lines = keys.map((key) => {
    const raw = env[key] ?? "";
    const display = isSensitiveKey(key) ? maskValue(raw) : raw;

    return `${indent}${key}=${display}`;
  });

  return [sectionHeader("Environment"), ...lines].join("\n");
}

async function renderConfigFull(config: BabConfig): Promise<string> {
  const plugins = await discoverAllPlugins(config);
  const parts = [
    renderBabInfo(config),
    renderPlugins(plugins),
    renderProviders(config),
    renderEnvironment(config),
  ];

  return `${parts.join("\n")}\n`;
}

function pluginsToJSON(
  bundled: Awaited<ReturnType<typeof discoverBundledPluginRecords>>,
  installed: Awaited<ReturnType<typeof discoverInstalledPluginRecords>>,
) {
  return [...bundled, ...installed]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      command: plugin.manifest.command,
      sourceType: plugin.sourceType,
      source: sourceLabel(plugin),
    }));
}

function providersToJSON(config: BabConfig) {
  const providers = Object.keys(PROVIDER_ENV_CONFIG) as ProviderId[];
  const env = config.env;

  return Object.fromEntries(
    providers.map((pid) => {
      const configured = isProviderConfigured(pid, env);
      const envVars = providerEnvVarNames(pid);

      return [pid, { configured, envVars }];
    }),
  );
}

function environmentToJSON(config: BabConfig) {
  const env = config.env;
  const providerKeys = getProviderEnvKeys();

  const keys = Object.keys(env)
    .filter((k) => isBabRelevant(k, providerKeys))
    .sort((left, right) => left.localeCompare(right));

  return Object.fromEntries(
    keys.map((key) => {
      const raw = env[key] ?? "";
      const value = isSensitiveKey(key) ? maskValue(raw) : raw;

      return [key, value];
    }),
  );
}

async function renderConfigJSON(config: BabConfig): Promise<string> {
  const plugins = await discoverAllPlugins(config);

  const output = {
    bab: {
      version: VERSION,
      persistence: config.persistence?.enabled ?? true,
      configDir: config.paths.baseDir,
    },
    plugins: pluginsToJSON(plugins.bundled, plugins.installed),
    providers: providersToJSON(config),
    environment: environmentToJSON(config),
  };

  return `${JSON.stringify(output, null, 2)}\n`;
}

export async function runConfigCommand(
  args: string[],
  context: ConfigCommandContext,
): Promise<number> {
  const json = args.includes("--json");

  if (json) {
    const output = await renderConfigJSON(context.config);
    writeLine(context.stdout, output);
    return 0;
  }

  const output = await renderConfigFull(context.config);
  writeLine(context.stdout, output);
  return 0;
}

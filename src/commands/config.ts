import type { BabConfig } from "../config";
import { PROVIDER_ENV_CONFIG } from "../providers/registry";
import type { ProviderId } from "../types";
import { VERSION } from "../version";
import {
  discoverBundledPluginRecords,
  discoverInstalledPluginRecords,
  formatTable,
  sourceLabel,
  type WritableLike,
  writeLine,
} from "./shared";

interface ConfigCommandContext {
  config: BabConfig;
  stdout: WritableLike;
}

const SECRET_SUFFIXES = [
  "_API_KEY",
  "_PASSWORD",
  "_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_ACCESS_KEY_ID",
  "_SECRET_ACCESS_KEY",
  "_SESSION_TOKEN",
];

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

async function renderPlugins(config: BabConfig): Promise<string> {
  const bundled = await discoverBundledPluginRecords();
  const installed = await discoverInstalledPluginRecords(config.paths);

  const rows = [
    ["ID", "Name", "Version", "Command", "Source Type", "Source Repo"],
    ...[...bundled, ...installed]
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

function renderProviders(config: BabConfig, indent = "  "): string {
  const providers = Object.keys(PROVIDER_ENV_CONFIG) as ProviderId[];

  const rows = providers.map((pid) => {
    const providerConfig = PROVIDER_ENV_CONFIG[pid];
    let configured: boolean;

    if (pid === "custom") {
      configured = Boolean(
        "baseUrl" in providerConfig &&
          providerConfig.baseUrl &&
          config.env[providerConfig.baseUrl],
      );
    } else {
      configured = Boolean(
        providerConfig.apiKey && config.env[providerConfig.apiKey],
      );
    }

    const envVar =
      pid === "custom" && "baseUrl" in providerConfig
        ? providerConfig.baseUrl
        : (providerConfig.apiKey ?? "—");

    return `${indent}${pid.padEnd(12)} ${configured ? "configured" : "not configured"} (${envVar})`;
  });

  return [sectionHeader("AI Providers"), ...rows].join("\n");
}

function renderEnvironment(config: BabConfig, indent = "  "): string {
  const env = config.env;
  const keys = Object.keys(env).sort((left, right) =>
    left.localeCompare(right),
  );

  const lines = keys.map((key) => {
    const raw = env[key] ?? "";
    const display = isSensitiveKey(key) ? maskValue(raw) : raw;

    return `${indent}${key}=${display}`;
  });

  return [sectionHeader("Environment"), ...lines].join("\n");
}

async function renderConfigFull(config: BabConfig): Promise<string> {
  const parts = [
    renderBabInfo(config),
    await renderPlugins(config),
    renderProviders(config),
    renderEnvironment(config),
  ];

  return `${parts.join("\n")}\n`;
}

function pluginsToJSON(
  _config: BabConfig,
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

  return Object.fromEntries(
    providers.map((pid) => {
      const providerConfig = PROVIDER_ENV_CONFIG[pid];
      let configured: boolean;

      if (pid === "custom") {
        configured = Boolean(
          "baseUrl" in providerConfig &&
            providerConfig.baseUrl &&
            config.env[providerConfig.baseUrl],
        );
      } else {
        configured = Boolean(
          providerConfig.apiKey && config.env[providerConfig.apiKey],
        );
      }

      const envVar =
        pid === "custom" && "baseUrl" in providerConfig
          ? providerConfig.baseUrl
          : (providerConfig.apiKey ?? "—");

      return [pid, { configured, envVar }];
    }),
  );
}

function environmentToJSON(config: BabConfig) {
  const env = config.env;
  const keys = Object.keys(env).sort((left, right) =>
    left.localeCompare(right),
  );

  return Object.fromEntries(
    keys.map((key) => {
      const raw = env[key] ?? "";
      const value = isSensitiveKey(key) ? maskValue(raw) : raw;

      return [key, value];
    }),
  );
}

async function renderConfigJSON(config: BabConfig): Promise<string> {
  const bundled = await discoverBundledPluginRecords();
  const installed = await discoverInstalledPluginRecords(config.paths);

  const output = {
    bab: {
      version: VERSION,
      persistence: config.persistence?.enabled ?? true,
      configDir: config.paths.baseDir,
    },
    plugins: pluginsToJSON(config, bundled, installed),
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

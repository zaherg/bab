import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import YAML from "yaml";
import { z } from "zod/v4";

import type { BabConfigPaths } from "../config";
import {
  type PluginManifest,
  PluginManifestSchema,
  type PluginRole,
} from "../types";
import { CommandError } from "./errors";

export interface WritableLike {
  write(chunk: string): unknown;
}

export interface CommandPluginRecord {
  directory: string;
  installMetadata?: PluginInstallMetadata;
  manifest: PluginManifest;
  manifestPath: string;
  sourceType: "bundled" | "installed";
}

export const PluginInstallMetadataSchema = z.object({
  installed_at: z.string(),
  installer_version: z.string(),
  manifest_name: z.string(),
  manifest_version: z.string(),
  plugin_id: z.string(),
  plugin_subdir: z.string(),
  resolved_commit: z.string(),
  adapter_hash: z.string().optional(),
  schema_version: z.literal(1),
  source_original: z.string(),
  source_ref: z.string().optional(),
  source_url: z.string(),
});

export type PluginInstallMetadata = z.infer<typeof PluginInstallMetadataSchema>;

export const BUNDLED_PLUGIN_IDS = ["opencode"] as const;

function isRoleDefinition(
  role: PluginRole,
): role is Extract<PluginRole, object> {
  return typeof role === "object";
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== "..")
  );
}

export function writeLine(stream: WritableLike, message = ""): void {
  stream.write(`${message}\n`);
}

export function formatTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  const firstRow = rows[0];

  if (!firstRow) {
    return "";
  }

  const columnWidths = firstRow.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );

  return rows
    .map((row, rowIndex) => {
      const formattedRow = row
        .map((cell, columnIndex) =>
          cell.padEnd(columnWidths[columnIndex] ?? cell.length),
        )
        .join("  ");

      if (rowIndex === 0) {
        const separator = columnWidths
          .map((width) => "-".repeat(width))
          .join("  ");
        return `${formattedRow}\n${separator}`;
      }

      return formattedRow;
    })
    .join("\n");
}

async function resolveSearchRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function hasBundledPluginManifest(
  rootDirectory: string,
): Promise<boolean> {
  for (const pluginId of BUNDLED_PLUGIN_IDS) {
    if (
      await pathExists(
        join(rootDirectory, "plugins", pluginId, "manifest.yaml"),
      )
    ) {
      return true;
    }
  }

  return false;
}

export async function getBundledPluginsRoot(
  searchRoots = [import.meta.dir, dirname(process.execPath)],
): Promise<string> {
  for (const searchRoot of searchRoots) {
    let currentDirectory = await resolveSearchRoot(searchRoot);

    while (true) {
      if (await hasBundledPluginManifest(currentDirectory)) {
        return join(currentDirectory, "plugins");
      }

      const parentDirectory = dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        break;
      }

      currentDirectory = parentDirectory;
    }
  }

  const extracted = await extractEmbeddedBundledPlugins();
  if (extracted) {
    return extracted;
  }

  return resolve(import.meta.dir, "..", "..", "plugins");
}

async function extractEmbeddedBundledPlugins(): Promise<string | undefined> {
  try {
    const module_ = (await import("../bundled-plugins.gen" as string)) as {
      bundledPlugins?: import("../../scripts/bundle-plugins").BundledPlugin[];
    };
    const plugins = module_.bundledPlugins;
    if (!plugins || plugins.length === 0) {
      return undefined;
    }

    const targetRoot = join(
      process.env.BAB_BUNDLED_PLUGINS_DIR ??
        join(homedir(), ".config", "bab", "bundled"),
    );
    const { extractBundledPlugins } = (await import(
      "../../scripts/bundle-plugins" as string
    )) as typeof import("../../scripts/bundle-plugins");
    return await extractBundledPlugins(targetRoot, plugins);
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

export async function readManifestFile(
  manifestPath: string,
): Promise<PluginManifest> {
  const manifestSource = await Bun.file(manifestPath).text();
  const parsed = YAML.parse(manifestSource, { maxAliasCount: 10 });

  return PluginManifestSchema.parse(parsed);
}

export async function readInstallMetadata(
  directory: string,
): Promise<PluginInstallMetadata | undefined> {
  const metadataPath = join(directory, ".install.json");

  try {
    const contents = await Bun.file(metadataPath).text();
    return PluginInstallMetadataSchema.parse(JSON.parse(contents));
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function ensurePathWithinDirectory(
  rootDirectory: string,
  candidatePath: string,
  description: string,
): Promise<void> {
  const resolvedRoot = await realpath(rootDirectory);
  const resolvedCandidatePath = resolve(resolvedRoot, candidatePath);

  if (!isPathInside(resolvedRoot, resolvedCandidatePath)) {
    throw new CommandError(
      `${description} points outside the plugin directory: ${candidatePath}`,
    );
  }

  let candidateStats: Awaited<ReturnType<typeof lstat>>;

  try {
    candidateStats = await lstat(resolvedCandidatePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CommandError(`${description} is missing: ${candidatePath}`);
    }

    throw error;
  }

  if (!candidateStats.isFile() && !candidateStats.isSymbolicLink()) {
    throw new CommandError(`${description} must be a file: ${candidatePath}`);
  }

  const resolvedCandidate = await realpath(resolvedCandidatePath);

  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new CommandError(
      `${description} resolves outside the plugin directory: ${candidatePath}`,
    );
  }
}

export async function validatePluginContents(
  pluginDirectory: string,
  manifest: PluginManifest,
): Promise<void> {
  await ensurePathWithinDirectory(pluginDirectory, "adapter.ts", "adapter.ts");

  for (const role of manifest.roles) {
    if (!isRoleDefinition(role) || !role.prompt_file) {
      continue;
    }

    await ensurePathWithinDirectory(
      pluginDirectory,
      role.prompt_file,
      `prompt file for role "${role.name}"`,
    );
  }
}

export async function discoverInstalledPluginRecords(
  configPaths: BabConfigPaths,
): Promise<CommandPluginRecord[]> {
  const entries = await readdir(configPaths.pluginsDir, {
    withFileTypes: true,
  });
  const plugins: CommandPluginRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".staging-")) {
      continue;
    }

    const directory = join(configPaths.pluginsDir, entry.name);
    const manifestPath = join(directory, "manifest.yaml");

    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const manifest = await readManifestFile(manifestPath);

    plugins.push({
      directory,
      installMetadata: await readInstallMetadata(directory),
      manifest,
      manifestPath,
      sourceType: "installed",
    });
  }

  return plugins.sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id),
  );
}

export async function discoverBundledPluginRecords(): Promise<
  CommandPluginRecord[]
> {
  const bundledRoot = await getBundledPluginsRoot();
  const plugins: CommandPluginRecord[] = [];

  for (const pluginId of BUNDLED_PLUGIN_IDS) {
    const directory = join(bundledRoot, pluginId);
    const manifestPath = join(directory, "manifest.yaml");

    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const manifest = await readManifestFile(manifestPath);

    plugins.push({
      directory,
      manifest,
      manifestPath,
      sourceType: "bundled",
    });
  }

  return plugins.sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id),
  );
}

export function sourceLabel(plugin: CommandPluginRecord): string {
  if (plugin.sourceType === "bundled") {
    return "bundled";
  }

  return plugin.installMetadata?.source_original ?? "installed";
}

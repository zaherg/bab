import { cp, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";

import type { BabConfig } from "../config";
import { generateSkillContent } from "../skills/generator";
import { regenerateSkills } from "../skills/index";
import type { PluginManifest } from "../types";
import { VERSION } from "../version";
import { CommandError } from "./errors";
import {
  BUNDLED_PLUGIN_IDS,
  formatTable,
  type PluginInstallMetadata,
  pathExists,
  readManifestFile,
  validatePluginContents,
  type WritableLike,
  writeLine,
} from "./shared";
import { type ParsedSource, parseSource } from "./source-parser";

interface RepositoryPluginCandidate {
  directory: string;
  manifest: PluginManifest;
  manifestPath: string;
  pluginSubdir: string;
}

interface AddCommandContext {
  config: BabConfig;
  isTty?: boolean;
  stderr: WritableLike;
  stdin: NodeJS.ReadableStream;
  stdout: WritableLike;
}

export interface InstallPluginsOptions {
  config: BabConfig;
  isTty?: boolean;
  source: ParsedSource;
  stderr: WritableLike;
  stdin: NodeJS.ReadableStream;
  stdout: WritableLike;
  tempDirectoryParent?: string;
  yes: boolean;
}

export interface InstalledPluginSummary {
  id: string;
  installPath: string;
  name: string;
  status: "installed";
}

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function normalizeCommandArgs(args: string[]): {
  source: string;
  yes: boolean;
} {
  let source: string | undefined;
  let yes = false;

  for (const argument of args) {
    if (argument === "--yes") {
      yes = true;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new CommandError(`Unknown option for add: ${argument}`);
    }

    if (source) {
      throw new CommandError(
        "Only one plugin source can be installed at a time",
      );
    }

    source = argument;
  }

  if (!source) {
    throw new CommandError("Plugin source is required");
  }

  return { source, yes };
}

async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  const subprocess = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}

async function cloneRepository(
  source: ParsedSource,
  cloneDirectory: string,
): Promise<void> {
  const shallowClone = await runGit([
    "clone",
    "--depth",
    "1",
    "--template=/dev/null",
    source.url,
    cloneDirectory,
  ]);

  if (shallowClone.exitCode !== 0) {
    throw new CommandError(
      `Failed to clone ${source.url}: ${shallowClone.stderr.trim() || shallowClone.stdout.trim()}`,
    );
  }

  if (!source.ref) {
    return;
  }

  const checkout = await runGit(["checkout", source.ref], cloneDirectory);

  if (checkout.exitCode === 0) {
    return;
  }

  await rm(cloneDirectory, { force: true, recursive: true });

  const fullClone = await runGit([
    "clone",
    "--template=/dev/null",
    source.url,
    cloneDirectory,
  ]);

  if (fullClone.exitCode !== 0) {
    throw new CommandError(
      `Failed to clone ${source.url}: ${fullClone.stderr.trim() || fullClone.stdout.trim()}`,
    );
  }

  const fullCheckout = await runGit(["checkout", source.ref], cloneDirectory);

  if (fullCheckout.exitCode !== 0) {
    throw new CommandError(
      `Failed to checkout ref "${source.ref}": ${
        fullCheckout.stderr.trim() || fullCheckout.stdout.trim()
      }`,
    );
  }
}

async function resolveCommitSha(repositoryDirectory: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], repositoryDirectory);

  if (result.exitCode !== 0) {
    throw new CommandError(
      `Failed to resolve repository commit: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout.trim();
}

async function discoverRepositoryPlugins(
  repositoryDirectory: string,
): Promise<RepositoryPluginCandidate[]> {
  const rootManifestPath = join(repositoryDirectory, "manifest.yaml");
  const rootHasManifest = await pathExists(rootManifestPath);
  const childEntries = await readdir(repositoryDirectory, {
    withFileTypes: true,
  });
  const childPluginDirectories: string[] = [];

  for (const entry of childEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childDirectory = join(repositoryDirectory, entry.name);
    const manifestPath = join(childDirectory, "manifest.yaml");

    if (await pathExists(manifestPath)) {
      childPluginDirectories.push(childDirectory);
    }
  }

  if (rootHasManifest && childPluginDirectories.length > 0) {
    throw new CommandError(
      "Repository layout is ambiguous: root manifest.yaml cannot coexist with child plugin manifests",
    );
  }

  if (rootHasManifest) {
    const manifest = await readManifestFile(rootManifestPath);
    return [
      {
        directory: repositoryDirectory,
        manifest,
        manifestPath: rootManifestPath,
        pluginSubdir: ".",
      },
    ];
  }

  if (childPluginDirectories.length === 0) {
    throw new CommandError("No plugins found in repository");
  }

  const plugins: RepositoryPluginCandidate[] = [];

  for (const directory of childPluginDirectories.sort((left, right) =>
    left.localeCompare(right),
  )) {
    const manifestPath = join(directory, "manifest.yaml");
    const manifest = await readManifestFile(manifestPath);

    plugins.push({
      directory,
      manifest,
      manifestPath,
      pluginSubdir: relative(repositoryDirectory, directory) || ".",
    });
  }

  return plugins;
}

async function validateRepositoryPlugins(
  config: BabConfig,
  candidates: RepositoryPluginCandidate[],
): Promise<void> {
  const seenIds = new Set<string>();

  for (const candidate of candidates) {
    await validatePluginContents(candidate.directory, candidate.manifest);

    if (seenIds.has(candidate.manifest.id)) {
      throw new CommandError(
        `Repository contains duplicate plugin id "${candidate.manifest.id}"`,
      );
    }

    seenIds.add(candidate.manifest.id);

    if (BUNDLED_PLUGIN_IDS.includes(candidate.manifest.id as "opencode")) {
      throw new CommandError(
        `Plugin id "${candidate.manifest.id}" conflicts with a bundled plugin`,
      );
    }

    const installedPath = join(config.paths.pluginsDir, candidate.manifest.id);

    if (await pathExists(installedPath)) {
      throw new CommandError(
        `Plugin "${candidate.manifest.id}" is already installed at ${installedPath}`,
      );
    }
  }
}

async function writeInstallMetadata(
  pluginDirectory: string,
  metadata: PluginInstallMetadata,
): Promise<void> {
  const metadataPath = join(pluginDirectory, ".install.json");
  const temporaryMetadataPath = `${metadataPath}.tmp`;

  await Bun.write(
    temporaryMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await rename(temporaryMetadataPath, metadataPath);
}

async function confirmInstall(
  candidates: RepositoryPluginCandidate[],
  commit: string,
  options: InstallPluginsOptions,
): Promise<void> {
  if (options.yes) {
    return;
  }

  if (!options.isTty) {
    throw new CommandError(
      "Confirmation required in non-interactive mode; re-run with --yes",
    );
  }

  writeLine(options.stderr, `Source: ${options.source.original}`);
  writeLine(options.stderr, `Resolved URL: ${options.source.url}`);

  if (options.source.ref) {
    writeLine(options.stderr, `Ref: ${options.source.ref}`);
  }

  writeLine(options.stderr, `Commit: ${commit}`);
  writeLine(options.stderr, "Plugins:");

  for (const candidate of candidates) {
    writeLine(
      options.stderr,
      `  - ${candidate.manifest.id} -> ${join(options.config.paths.pluginsDir, candidate.manifest.id)}`,
    );
  }

  writeLine(options.stderr, "");
  writeLine(
    options.stderr,
    "⚠ WARNING: Plugin adapters run as trusted code with full access to your",
  );
  writeLine(
    options.stderr,
    "  filesystem and network. Only install plugins from sources you trust.",
  );
  writeLine(options.stderr, "");

  const prompt = createInterface({
    input: options.stdin,
    output: options.stderr as NodeJS.WritableStream,
  });

  try {
    const answer = await prompt.question("Proceed with installation? [y/N] ");

    if (!/^y(?:es)?$/iu.test(answer.trim())) {
      throw new CommandError("Installation cancelled");
    }
  } finally {
    prompt.close();
  }
}

function summarizeInstalledPlugins(
  installedPlugins: InstalledPluginSummary[],
): string {
  return formatTable([
    ["Name", "ID", "Path", "Status"],
    ...installedPlugins.map((plugin) => [
      plugin.name,
      plugin.id,
      plugin.installPath,
      plugin.status,
    ]),
  ]);
}

export async function installPluginsFromSource(
  options: InstallPluginsOptions,
): Promise<InstalledPluginSummary[]> {
  const tempParent = options.tempDirectoryParent ?? tmpdir();
  const tempRoot = await mkdtemp(join(tempParent, "bab-add-"));
  const cloneDirectory = join(tempRoot, "clone");
  const stagedDirectories: string[] = [];
  const installedDirectories: string[] = [];

  try {
    await cloneRepository(options.source, cloneDirectory);
    const commit = await resolveCommitSha(cloneDirectory);
    const candidates = await discoverRepositoryPlugins(cloneDirectory);

    await validateRepositoryPlugins(options.config, candidates);
    await confirmInstall(candidates, commit, options);

    const summaries: InstalledPluginSummary[] = [];

    for (const candidate of candidates) {
      const stageDirectory = join(
        options.config.paths.pluginsDir,
        `.staging-${candidate.manifest.id}-${crypto.randomUUID()}`,
      );

      await cp(candidate.directory, stageDirectory, {
        dereference: false,
        errorOnExist: true,
        recursive: true,
      });
      stagedDirectories.push(stageDirectory);

      let adapterHash: string | undefined;

      try {
        const adapterContent = await Bun.file(
          join(stageDirectory, "adapter.ts"),
        ).text();
        const hasher = new Bun.CryptoHasher("sha256");

        hasher.update(adapterContent);
        adapterHash = hasher.digest("hex");
      } catch {
        // No adapter file or read error — hash stays undefined
      }

      await writeInstallMetadata(stageDirectory, {
        adapter_hash: adapterHash,
        installed_at: new Date().toISOString(),
        installer_version: VERSION,
        manifest_name: candidate.manifest.name,
        manifest_version: candidate.manifest.version,
        plugin_id: candidate.manifest.id,
        plugin_subdir: candidate.pluginSubdir,
        resolved_commit: commit,
        schema_version: 1,
        source_original: options.source.original,
        source_ref: options.source.ref,
        source_url: options.source.url,
      });

      const finalDirectory = join(
        options.config.paths.pluginsDir,
        candidate.manifest.id,
      );
      await rename(stageDirectory, finalDirectory);
      installedDirectories.push(finalDirectory);

      summaries.push({
        id: candidate.manifest.id,
        installPath: finalDirectory,
        name: candidate.manifest.name,
        status: "installed",
      });
    }

    writeLine(options.stdout, summarizeInstalledPlugins(summaries));
    return summaries;
  } catch (error) {
    await Promise.allSettled(
      stagedDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
    await Promise.allSettled(
      installedDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
    throw error;
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function runAddCommand(
  args: string[],
  context: AddCommandContext,
): Promise<number> {
  const { source, yes } = normalizeCommandArgs(args);

  const summaries = await installPluginsFromSource({
    config: context.config,
    isTty: context.isTty,
    source: parseSource(source),
    stderr: context.stderr,
    stdin: context.stdin,
    stdout: context.stdout,
    yes,
  });

  if (summaries.length > 0) {
    try {
      await regenerateSkills(() => generateSkillContent(context.config), {
        stderr: context.stderr,
      });
    } catch (error) {
      context.stderr.write(
        `Warning: failed to update agent skills: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return 0;
}

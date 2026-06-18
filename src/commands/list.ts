import type { BabConfig } from "../config";
import { CommandError } from "./errors";
import {
  discoverBundledPluginRecords,
  discoverInstalledPluginRecords,
  formatTable,
  isPluginCommandAvailable,
  sourceLabel,
  type WritableLike,
  writeLine,
} from "./shared";

interface ListCommandContext {
  config: BabConfig;
  stdout: WritableLike;
}

export async function runListCommand(
  args: string[],
  context: ListCommandContext,
): Promise<number> {
  if (args.length > 0) {
    throw new CommandError("`bab list` does not accept additional arguments");
  }

  const bundled = await discoverBundledPluginRecords();
  const installed = await discoverInstalledPluginRecords(context.config.paths);
  const rows = [
    [
      "ID",
      "Name",
      "Version",
      "Command",
      "Source Type",
      "Source Repo",
      "Status",
      "Note",
    ],
    ...[...bundled, ...installed]
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map((plugin) => {
        const active = isPluginCommandAvailable(plugin.manifest.command);
        return [
          plugin.manifest.id,
          plugin.manifest.name,
          plugin.manifest.version,
          plugin.manifest.command,
          plugin.sourceType,
          sourceLabel(plugin),
          active ? "active" : "disabled",
          active
            ? ""
            : `CLI "${plugin.manifest.command}" not found on PATH (re-checked next startup)`,
        ];
      }),
  ];

  writeLine(context.stdout, formatTable(rows));
  return 0;
}

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import codereviewerPrompt from "../prompts/delegate/codereviewer.txt";
import codingPrompt from "../prompts/delegate/coding.txt";
import defaultPrompt from "../prompts/delegate/default.txt";
import plannerPrompt from "../prompts/delegate/planner.txt";
import type { PluginRole, RoleDefinition } from "../types";
import type { LoadedPlugin } from "./types";

const BUILT_IN_PROMPTS: Record<string, string> = {
  coding: codingPrompt,
  codereviewer: codereviewerPrompt,
  default: defaultPrompt,
  planner: plannerPrompt,
};

function isRoleDefinition(role: PluginRole): role is RoleDefinition {
  return typeof role === "object";
}

export async function resolveRole(
  plugin: LoadedPlugin,
  roleName: string,
): Promise<{
  args: Record<string, string | number | boolean>;
  name: string;
  prompt: string;
  source: "built_in" | "plugin";
}> {
  const pluginRole = plugin.manifest.roles.find((role) =>
    isRoleDefinition(role) ? role.name === roleName : false,
  );

  if (pluginRole && isRoleDefinition(pluginRole)) {
    const inheritedPrompt = pluginRole.inherits
      ? (BUILT_IN_PROMPTS[pluginRole.inherits] ?? "")
      : "";
    const promptPath = pluginRole.prompt_file
      ? resolve(plugin.directory, pluginRole.prompt_file)
      : undefined;

    if (promptPath) {
      const realPluginDir = await realpath(plugin.directory);
      const realPromptPath = await realpath(promptPath);

      if (
        realPromptPath !== realPluginDir &&
        !realPromptPath.startsWith(`${realPluginDir}/`)
      ) {
        throw new Error(
          `prompt_file must be within plugin directory: ${pluginRole.prompt_file}`,
        );
      }
    }

    const pluginPrompt = promptPath ? await Bun.file(promptPath).text() : "";

    return {
      args: pluginRole.args,
      name: pluginRole.name,
      prompt: [inheritedPrompt, pluginPrompt].filter(Boolean).join("\n\n"),
      source: "plugin",
    };
  }

  const builtInPrompt = BUILT_IN_PROMPTS[roleName];

  if (builtInPrompt !== undefined) {
    return {
      args: {},
      name: roleName,
      prompt: builtInPrompt,
      source: "built_in",
    };
  }

  throw new Error(`Unknown role: ${roleName}`);
}

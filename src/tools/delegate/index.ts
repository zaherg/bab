import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod/v4";

import type { BabConfig } from "../../config";
import { getLoadedPlugins } from "../../delegate/plugin-cache";
import { resolveRole } from "../../delegate/roles";
import type { RegisteredTool } from "../../server";
import type { DelegateEvent, ToolOutput } from "../../types";
import { mergeEnv } from "../../utils/env";
import { getClientLogger } from "../../utils/logger";
import { createToolError } from "../base";

function validateWorkingDirectory(dir: string): string | undefined {
  const resolved = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  try {
    const real = realpathSync(resolved);
    if (!statSync(real).isDirectory()) return "not a directory";
    const cwd = realpathSync(process.cwd());
    const home = homedir();
    const tmp = resolve(tmpdir());
    if (
      real === cwd ||
      real.startsWith(`${cwd}/`) ||
      real === home ||
      real.startsWith(`${home}/`) ||
      real === tmp ||
      real.startsWith(`${tmp}/`)
    ) {
      return undefined;
    }
    return "working_directory must be within the project root, home, or tmp";
  } catch {
    return "working_directory does not exist";
  }
}

const MAX_OUTPUT_LENGTH = 20_000;
const SUMMARY_PATTERN = /<SUMMARY>([\s\S]*?)<\/SUMMARY>/iu;

function sanitizeOutput(content: string): {
  content: string;
  summary?: string;
} {
  const summaryMatch = content.match(SUMMARY_PATTERN);
  const summary = summaryMatch?.[1].trim();
  const withoutSummary = content.replace(SUMMARY_PATTERN, "").trim();

  if (withoutSummary.length <= MAX_OUTPUT_LENGTH) {
    return {
      content: withoutSummary,
      summary,
    };
  }

  const truncatedChars = withoutSummary.length - 18_000 - 2_000;
  return {
    content: `${withoutSummary.slice(0, 18_000)}\n\n...[truncated ${truncatedChars} chars]...\n\n${withoutSummary.slice(-2_000)}`,
    summary,
  };
}

const METADATA_BLOAT_KEYS = new Set(["events", "raw_events", "raw"]);
const MAX_METADATA_SIZE = 10_000;

function sanitizeProviderMetadata(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(raw).filter(
    ([key]) => !METADATA_BLOAT_KEYS.has(key),
  );
  const cleaned = Object.fromEntries(entries);

  let serialized: string;

  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    return { _error: "metadata_not_serializable" };
  }

  if (serialized.length <= MAX_METADATA_SIZE) {
    return cleaned;
  }

  const originalSize = serialized.length;
  const droppedKeys: string[] = [];

  const sizeOf = (key: string) => {
    try {
      return JSON.stringify(cleaned[key]).length;
    } catch {
      return 0;
    }
  };

  const keysBySize = Object.keys(cleaned).sort((a, b) => sizeOf(b) - sizeOf(a));

  for (const key of keysBySize) {
    delete cleaned[key];
    droppedKeys.push(key);

    try {
      if (JSON.stringify(cleaned).length + 200 <= MAX_METADATA_SIZE) {
        return {
          ...cleaned,
          _truncated: true,
          _original_size: originalSize,
          _dropped_keys: droppedKeys,
        };
      }
    } catch {}
  }

  return {
    _truncated: true,
    _original_size: originalSize,
    _dropped_keys: droppedKeys,
  };
}

async function collectEvents(
  events: AsyncIterable<DelegateEvent> | DelegateEvent[],
  providerId: string,
  runId: string,
): Promise<DelegateEvent[]> {
  const collectedEvents: DelegateEvent[] = [];

  if (Symbol.asyncIterator in events) {
    for await (const event of events) {
      collectedEvents.push(event);
    }
  } else {
    collectedEvents.push(...events);
  }

  const doneEvents = collectedEvents.filter((event) => event.type === "done");

  if (doneEvents.length === 0) {
    collectedEvents.push({
      metadata: {},
      provider_id: providerId,
      run_id: runId,
      timestamp: new Date().toISOString(),
      type: "done",
    });
  } else if (doneEvents.length > 1) {
    const firstDone = doneEvents[0];
    return [
      ...collectedEvents.filter((event) => event.type !== "done"),
      firstDone,
    ];
  }

  return collectedEvents;
}

export function createDelegateTool(config: BabConfig): RegisteredTool {
  return {
    description: "Run a prompt through a configured delegate CLI plugin.",
    execute: async (args) => {
      const cliName =
        typeof args.cli_name === "string" ? args.cli_name : undefined;
      const roleName = typeof args.role === "string" ? args.role : "default";
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const workingDirectory =
        typeof args.working_directory === "string"
          ? args.working_directory
          : process.cwd();

      const wdError = validateWorkingDirectory(workingDirectory);
      if (wdError) {
        return {
          ok: false,
          error: createToolError("validation", wdError, {
            working_directory: workingDirectory,
          }),
        };
      }

      try {
        const loadedPlugins = await getLoadedPlugins(config);
        const plugin =
          (cliName
            ? loadedPlugins.find(
                (candidate) => candidate.manifest.id === cliName,
              )
            : loadedPlugins.length === 1
              ? loadedPlugins[0]
              : undefined) ?? undefined;

        if (!plugin) {
          return {
            error: createToolError(
              "not_found",
              cliName
                ? `Unknown plugin: ${cliName}`
                : "cli_name is required when multiple or zero plugins are available",
            ),
            ok: false,
          };
        }

        if (!plugin.adapter) {
          return {
            error: createToolError(
              "configuration",
              `Plugin ${plugin.manifest.id} does not provide an adapter.ts`,
            ),
            ok: false,
          };
        }

        const role = await resolveRole(plugin, roleName);
        const runId = crypto.randomUUID();
        const clientLog = getClientLogger(plugin.manifest.id);
        const delegateStart = Date.now();

        clientLog.info("Delegate request", {
          role: role.name,
          prompt_length: prompt.length,
          run_id: runId,
        });

        const rawEvents = await plugin.adapter.run({
          env: mergeEnv(process.env, config.env, plugin.env),
          prompt,
          role,
          runId,
          workingDirectory,
        });
        const events = await collectEvents(
          rawEvents,
          plugin.manifest.id,
          runId,
        );

        clientLog.info("Delegate response", {
          role: role.name,
          duration_ms: Date.now() - delegateStart,
          status: "success",
          event_count: events.length,
          run_id: runId,
        });

        const outputText = events
          .filter((event) => event.type === "output")
          .map((event) => event.content)
          .join("\n\n");
        const sanitizedOutput = sanitizeOutput(outputText);
        const doneEvent = events.find((event) => event.type === "done");

        const toolOutput: ToolOutput = {
          content: sanitizedOutput.content,
          content_type: "markdown",
          metadata: {
            ...(doneEvent?.type === "done"
              ? sanitizeProviderMetadata(doneEvent.metadata ?? {})
              : {}),
            done_event_count: events.filter((event) => event.type === "done")
              .length,
            event_count: events.length,
            plugin_id: plugin.manifest.id,
            role: role.name,
            run_id: runId,
            summary: sanitizedOutput.summary,
          },
          status: "success",
        };

        return {
          ok: true,
          value: toolOutput,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Unknown role:")
        ) {
          return {
            error: createToolError("not_found", error.message),
            ok: false,
          };
        }

        return {
          error: createToolError(
            error instanceof Error && /timeout/iu.test(error.message)
              ? "timeout"
              : "execution",
            error instanceof Error
              ? error.message
              : "Delegate execution failed",
            error,
          ),
          ok: false,
        };
      }
    },
    inputSchema: z.object({
      cli_name: z
        .string()
        .optional()
        .describe(
          "Plugin ID to delegate to (e.g. 'claude', 'codex', 'copilot'). " +
            "Required when multiple plugins installed, optional with exactly one.",
        ),
      prompt: z.string().min(1),
      role: z
        .string()
        .default("default")
        .describe(
          "Prompt role within the selected plugin (e.g. 'default', 'architect'). " +
            "This does NOT select the plugin — use cli_name for that.",
        ),
      working_directory: z.string().optional(),
    }),
    name: "delegate",
  };
}

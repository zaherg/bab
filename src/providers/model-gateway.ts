import type { BabConfig } from "../config";
import { getLoadedPlugins } from "../delegate/plugin-cache";
import { resolveRole } from "../delegate/roles";
import { mergeEnv } from "../utils/env";
import { logger } from "../utils/logger";
import { estimateTokenCount } from "../utils/tokens";
import type {
  GenerateTextResult,
  ProviderRegistry,
  ThinkingMode,
} from "./registry";

export interface ModelQueryOptions {
  temperature?: number;
  thinkingMode?: ThinkingMode;
  toolName?: string;
  workingDirectory?: string;
}

/**
 * Routes a model query to either the SDK provider registry or the delegate
 * plugin pipeline, depending on the model ID.
 *
 * SDK models: matched against the provider registry by ID or alias.
 * Plugin models: identified by "pluginId/modelName" format — the plugin
 * handles execution via its CLI adapter with model passed as a role arg.
 */
export class ModelGateway {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly config: BabConfig,
  ) {}

  async query(
    modelId: string,
    prompt: string,
    systemPrompt?: string,
    options: ModelQueryOptions = {},
  ): Promise<GenerateTextResult> {
    // Try SDK registry first
    const modelInfo = await this.providerRegistry.getModelInfo(modelId);

    if (modelInfo) {
      const result = await this.providerRegistry.generateText(
        modelId,
        prompt,
        systemPrompt,
        {
          temperature: options.temperature,
          thinkingMode: options.thinkingMode,
        },
      );
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }

    // Fall back to delegate pipeline: expect "pluginId/modelName"
    const slashIndex = modelId.indexOf("/");

    if (slashIndex === -1) {
      const available = (await this.providerRegistry.listModels())
        .map((m) => m.id)
        .join(", ");
      throw new Error(
        `Model "${modelId}" not found in SDK registry. ` +
          `Available SDK models: ${available || "none (no API keys configured)"}. ` +
          `For plugin models, use "pluginId/modelName" format (e.g. "copilot/claude-sonnet-4").`,
      );
    }

    const pluginId = modelId.slice(0, slashIndex);
    const modelName = modelId.slice(slashIndex + 1);

    return this.queryViaDelegate(
      pluginId,
      modelName,
      prompt,
      systemPrompt,
      options,
    );
  }

  private async queryViaDelegate(
    pluginId: string,
    modelName: string,
    prompt: string,
    systemPrompt: string | undefined,
    options: ModelQueryOptions,
  ): Promise<GenerateTextResult> {
    const loadedPlugins = await getLoadedPlugins(this.config);
    const plugin = loadedPlugins.find((p) => p.manifest.id === pluginId);

    if (!plugin) {
      const available =
        loadedPlugins.map((p) => p.manifest.id).join(", ") || "none";
      throw new Error(
        `Model "${pluginId}/${modelName}" not found. ` +
          `Plugin "${pluginId}" is not installed. Available plugins: ${available}`,
      );
    }

    if (!plugin.adapter) {
      throw new Error(
        `Plugin "${pluginId}" does not provide an adapter and cannot be used for model queries.`,
      );
    }

    const role = await resolveRole(plugin, "default");
    const pluginPromptOverride = options.toolName
      ? plugin.resolvedToolPrompts?.[options.toolName]
      : undefined;

    if (pluginPromptOverride) {
      logger.debug(
        `Using plugin "${pluginId}" prompt override for tool "${options.toolName}"`,
      );
    }

    const delegateSystemPrompt = pluginPromptOverride ?? systemPrompt;

    // Inject model and thinking_mode as role args for the adapter to use
    const augmentedRole = {
      ...role,
      args: {
        ...role.args,
        model: modelName,
        ...(options.thinkingMode && { thinking_mode: options.thinkingMode }),
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
      },
    };

    // Prepend system prompt to the prompt if provided (delegate has no separate system field)
    const fullPrompt = delegateSystemPrompt
      ? `${delegateSystemPrompt}\n\n${prompt}`
      : prompt;

    const runId = crypto.randomUUID();
    const rawEvents = await plugin.adapter.run({
      env: mergeEnv(process.env, this.config.env, plugin.env),
      prompt: fullPrompt,
      role: augmentedRole,
      runId,
      workingDirectory: options.workingDirectory ?? process.cwd(),
    });

    // Collect events (handle both array and async iterable)
    const events: Array<{ type: string; content?: string }> = [];

    if (Symbol.asyncIterator in rawEvents) {
      for await (const event of rawEvents as AsyncIterable<{
        type: string;
        content?: string;
      }>) {
        events.push(event);
      }
    } else {
      events.push(...(rawEvents as Array<{ type: string; content?: string }>));
    }

    const outputText = events
      .filter((e) => e.type === "output")
      .map((e) => e.content ?? "")
      .join("\n\n");

    if (!outputText) {
      throw new Error(
        `Plugin "${pluginId}" returned no output for model "${modelName}".`,
      );
    }

    // Delegate pipeline doesn't return structured usage — estimate
    const inputTokens = estimateTokenCount(fullPrompt);
    const outputTokens = estimateTokenCount(outputText);

    return {
      model: `${pluginId}/${modelName}`,
      provider: "custom",
      text: outputText,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }
}

export function createModelGateway(
  providerRegistry: ProviderRegistry,
  config: BabConfig,
): ModelGateway {
  return new ModelGateway(providerRegistry, config);
}

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter, openrouter } from "@openrouter/ai-sdk-provider";
import {
  generateText as aiGenerateText,
  type JSONValue,
  type LanguageModel,
} from "ai";

import type { BabConfig } from "../config";
import type { ModelInfo, ProviderId, Result, ToolError } from "../types";
import { estimateTokenCount } from "../utils/tokens";
import { customProviderBaseUrl } from "./custom-url";
import { discoverModels, getAllCachedModels } from "./model-discovery";

type GenerateTextFn = typeof aiGenerateText;

export interface ProviderRegistryOptions {
  config: BabConfig;
  generateTextFn?: GenerateTextFn;
}

export type ThinkingMode = "minimal" | "low" | "medium" | "high" | "max";

export interface GenerateTextOptions {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  thinkingMode?: ThinkingMode;
}

export interface GenerateTextResult {
  model: string;
  provider: ProviderId;
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

interface LanguageModelProvider {
  languageModel(modelId: string): LanguageModel;
}

type ProviderFactory = LanguageModelProvider;

// Static model registry — manually curated fallback entries.
// Scores are relative quality tiers (0-100) set by hand; update here when
// a model is superseded or pricing changes significantly.
// For providers with dynamic discovery (Google, OpenAI, OpenRouter), these
// entries act as overrides that take priority over discovered models. Only
// remove a static entry when you have confirmed dynamic discovery returns
// equivalent data for that model.
const STATIC_MODEL_REGISTRY: ReadonlyArray<ModelInfo> = [
  {
    id: "gemini-2.5-pro", // last_verified: 2026-03-26
    provider: "google",
    display_name: "Gemini 2.5 Pro",
    capabilities: {
      aliases: ["google/gemini-2.5-pro"],
      context_window: 1_048_576,
      description: "High-end reasoning and coding model from Google.",
      score: 100,
      supports_images: true,
      supports_thinking: true,
      supports_vision: true,
    },
  },
  {
    id: "gpt-5.2", // last_verified: 2026-03-26
    provider: "openai",
    display_name: "GPT-5.2",
    capabilities: {
      aliases: ["openai/gpt-5.2"],
      context_window: 400_000,
      description: "General-purpose flagship OpenAI model.",
      score: 100,
      supports_images: true,
      supports_thinking: true,
      supports_vision: true,
    },
  },
  {
    id: "claude-sonnet-4-20250514", // last_verified: 2026-03-26
    provider: "anthropic",
    display_name: "Claude Sonnet 4",
    capabilities: {
      aliases: ["anthropic/claude-sonnet-4"],
      context_window: 200_000,
      description: "Balanced Anthropic model for coding and reasoning.",
      score: 95,
      supports_images: true,
      supports_thinking: true,
      supports_vision: true,
    },
  },
  {
    id: "openai/gpt-5.2", // last_verified: 2026-03-26
    provider: "openrouter",
    display_name: "OpenRouter GPT-5.2",
    capabilities: {
      aliases: ["openrouter/openai/gpt-5.2"],
      context_window: 400_000,
      description: "OpenRouter-hosted GPT-5.2 compatible endpoint.",
      score: 100,
      supports_images: true,
      supports_thinking: true,
      supports_vision: true,
    },
  },
  {
    id: "custom/default", // last_verified: 2026-03-26
    provider: "custom",
    display_name: "Custom Default Model",
    capabilities: {
      aliases: ["custom/default-model"],
      context_window: 128_000,
      description: "OpenAI-compatible custom endpoint model.",
      score: 50,
      supports_images: false,
      supports_thinking: false,
      supports_vision: false,
    },
  },
] as const;

const MODEL_PREFIX_TO_PROVIDER: ReadonlyArray<[RegExp, ProviderId]> = [
  [/^claude-/, "anthropic"],
  [/^gpt-/, "openai"],
  [/^o\d+-/, "openai"],
  [/^gemini-/, "google"],
];

function inferProvider(modelId: string): ProviderId | undefined {
  for (const [pattern, provider] of MODEL_PREFIX_TO_PROVIDER) {
    if (pattern.test(modelId)) return provider;
  }
  return undefined;
}

const SYNTHETIC_DEFAULTS: ModelInfo["capabilities"] = {
  context_window: 128_000,
  score: 50,
  supports_thinking: false,
  supports_vision: false,
  supports_images: false,
  aliases: [],
};

export const PROVIDER_ENV_CONFIG = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY" },
  custom: { apiKey: "CUSTOM_API_KEY", baseUrl: "CUSTOM_API_URL" },
  google: { apiKey: "GOOGLE_API_KEY" },
  openai: { apiKey: "OPENAI_API_KEY" },
  openrouter: { apiKey: "OPENROUTER_API_KEY" },
} as const satisfies Record<ProviderId, { apiKey?: string; baseUrl?: string }>;

export function providerEnvVarNames(pid: ProviderId): string[] {
  const pc = PROVIDER_ENV_CONFIG[pid];
  const keys: string[] = [];
  if (pc.apiKey) keys.push(pc.apiKey);
  if (pid === "custom" && "baseUrl" in pc && pc.baseUrl) keys.push(pc.baseUrl);
  return keys;
}

export class ProviderRegistry {
  private readonly config: BabConfig;
  private readonly generateTextFn: GenerateTextFn;
  private readonly providerFactories = new Map<ProviderId, ProviderFactory>();

  constructor({
    config,
    generateTextFn = aiGenerateText,
  }: ProviderRegistryOptions) {
    this.config = config;
    this.generateTextFn = generateTextFn;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Trigger discovery for all configured providers (uses cache if fresh)
    await Promise.all(
      this.configuredProviders().map((pid) => this.discoverProviderModels(pid)),
    );
    const discovered = getAllCachedModels();
    // Static takes priority — deduplicate by id
    const merged = new Map<string, ModelInfo>();
    for (const m of discovered) merged.set(m.id, m);
    for (const m of STATIC_MODEL_REGISTRY) merged.set(m.id, m);
    return Array.from(merged.values()).filter((m) =>
      this.isProviderConfigured(m.provider),
    );
  }

  async getModelInfo(modelIdOrAlias: string): Promise<ModelInfo | undefined> {
    // 1. Static registry — exact id, then alias
    const exactMatch = STATIC_MODEL_REGISTRY.find(
      (model) => model.id === modelIdOrAlias,
    );
    if (exactMatch) return exactMatch;

    const aliasMatch = STATIC_MODEL_REGISTRY.find((model) =>
      model.capabilities.aliases.includes(modelIdOrAlias),
    );
    if (aliasMatch) return aliasMatch;

    // 2. Discovered models — fetch lazily per configured provider
    for (const pid of this.configuredProviders()) {
      const models = await this.discoverProviderModels(pid);
      const found = models.find(
        (m) =>
          m.id === modelIdOrAlias ||
          m.capabilities.aliases.includes(modelIdOrAlias),
      );
      if (found) return found;
    }

    // 3. Regex inference fallback (offline safety net)
    // Inferred models are config-gated here (unlike static models) because
    // ModelGateway uses getModelInfo() to decide SDK vs delegate routing —
    // returning an unconfigured inferred model would prevent delegate fallback.
    const inferred = inferProvider(modelIdOrAlias);
    if (inferred && this.isProviderConfigured(inferred)) {
      return {
        id: modelIdOrAlias,
        provider: inferred,
        display_name: modelIdOrAlias,
        capabilities: { ...SYNTHETIC_DEFAULTS },
      };
    }

    return undefined;
  }

  isProviderConfigured(providerId: ProviderId): boolean {
    const providerConfig = PROVIDER_ENV_CONFIG[providerId];

    if (providerId === "custom") {
      return Boolean(
        "baseUrl" in providerConfig &&
          providerConfig.baseUrl &&
          this.config.env[providerConfig.baseUrl],
      );
    }

    return Boolean(
      providerConfig.apiKey && this.config.env[providerConfig.apiKey],
    );
  }

  private configuredProviders(): ProviderId[] {
    return (Object.keys(PROVIDER_ENV_CONFIG) as ProviderId[]).filter((pid) =>
      this.isProviderConfigured(pid),
    );
  }

  private async discoverProviderModels(pid: ProviderId): Promise<ModelInfo[]> {
    const cfg = PROVIDER_ENV_CONFIG[pid];
    const apiKey = cfg.apiKey ? (this.config.env[cfg.apiKey] ?? "") : "";
    const baseUrl =
      "baseUrl" in cfg && cfg.baseUrl
        ? this.config.env[cfg.baseUrl]
        : undefined;
    return discoverModels(pid, apiKey, baseUrl, {
      allowInsecureCustomUrl: this.config.env.BAB_ALLOW_INSECURE_CUSTOM === "1",
    });
  }

  async generateText(
    modelIdOrAlias: string,
    prompt: string,
    systemPrompt?: string,
    options: GenerateTextOptions = {},
  ): Promise<Result<GenerateTextResult, ToolError>> {
    const modelInfo = await this.getModelInfo(modelIdOrAlias);

    if (!modelInfo) {
      return {
        ok: false,
        error: {
          type: "not_found",
          message: `Unknown model: ${modelIdOrAlias}`,
          retryable: false,
        },
      };
    }

    if (!this.isProviderConfigured(modelInfo.provider)) {
      const envVar = PROVIDER_ENV_CONFIG[modelInfo.provider].apiKey;
      return {
        ok: false,
        error: {
          type: "configuration",
          message: `Provider not configured: ${modelInfo.provider}. Set ${envVar} to enable it.`,
          retryable: false,
        },
      };
    }

    try {
      const provider = this.getProviderFactory(modelInfo.provider);
      const model = provider.languageModel(modelInfo.id) as LanguageModel;
      const providerOptions = this.buildProviderOptions(
        modelInfo.provider,
        options.thinkingMode,
      );
      const result = await this.generateTextFn({
        abortSignal: options.abortSignal,
        maxOutputTokens: options.maxOutputTokens,
        model,
        prompt,
        ...(Object.keys(providerOptions).length > 0
          ? {
              providerOptions: providerOptions as Record<
                string,
                Record<string, JSONValue>
              >,
            }
          : {}),
        system: systemPrompt,
        temperature: options.temperature,
      });

      const inputTokens =
        result.usage?.inputTokens ?? estimateTokenCount(prompt);
      const outputTokens =
        result.usage?.outputTokens ?? estimateTokenCount(result.text);

      return {
        ok: true,
        value: {
          model: modelInfo.id,
          provider: modelInfo.provider,
          text: result.text,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens:
              result.usage?.totalTokens ?? inputTokens + outputTokens,
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          type: "execution",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }

  private buildProviderOptions(
    provider: ProviderId,
    thinkingMode: ThinkingMode | undefined,
  ): Record<string, Record<string, unknown>> {
    if (!thinkingMode) {
      return {};
    }

    const ANTHROPIC_BUDGET: Record<ThinkingMode, number> = {
      minimal: 1_024,
      low: 5_000,
      medium: 20_000,
      high: 50_000,
      max: 80_000,
    };

    const OPENAI_EFFORT: Record<ThinkingMode, string> = {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      max: "high",
    };

    switch (provider) {
      case "anthropic":
        return {
          anthropic: {
            thinking: {
              type: "enabled",
              budgetTokens: ANTHROPIC_BUDGET[thinkingMode],
            },
          },
        };
      case "openai":
        return { openai: { reasoningEffort: OPENAI_EFFORT[thinkingMode] } };
      // Google thinking is implicit; custom/openrouter: silently ignore
      default:
        return {};
    }
  }

  private getProviderFactory(providerId: ProviderId): ProviderFactory {
    const existingProvider = this.providerFactories.get(providerId);

    if (existingProvider) {
      return existingProvider;
    }

    const provider = this.createProviderFactory(providerId);
    this.providerFactories.set(providerId, provider);
    return provider;
  }

  private createProviderFactory(providerId: ProviderId): ProviderFactory {
    switch (providerId) {
      case "google": {
        const apiKey = this.config.env.GOOGLE_API_KEY;
        return apiKey ? createGoogleGenerativeAI({ apiKey }) : google;
      }
      case "openai": {
        const apiKey = this.config.env.OPENAI_API_KEY;
        return apiKey ? createOpenAI({ apiKey }) : openai;
      }
      case "anthropic": {
        const apiKey = this.config.env.ANTHROPIC_API_KEY;
        return apiKey ? createAnthropic({ apiKey }) : anthropic;
      }
      case "openrouter":
        return this.config.env.OPENROUTER_API_KEY
          ? createOpenRouter({
              apiKey: this.config.env.OPENROUTER_API_KEY,
            })
          : openrouter;
      case "custom":
        return createOpenAICompatible({
          apiKey: this.config.env.CUSTOM_API_KEY,
          baseURL: customProviderBaseUrl(this.config.env),
          name: "custom",
        });
    }
  }
}

export function createProviderRegistry(config: BabConfig): ProviderRegistry {
  return new ProviderRegistry({ config });
}

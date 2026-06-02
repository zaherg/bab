import type { ModelInfo, ProviderId } from "../types";
import { logger } from "../utils/logger";
import { validateCustomApiUrl } from "./custom-url";

const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

const PROVIDER_API_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  anthropic: "https://api.anthropic.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
};

const PROVIDER_DEFAULT_CONTEXT: Partial<Record<ProviderId, number>> = {
  anthropic: 200_000,
  openai: 128_000,
  google: 128_000,
  openrouter: 128_000,
};

interface CacheEntry {
  models: ModelInfo[];
  fetchedAt: number;
}

interface DiscoverModelsOptions {
  allowInsecureCustomUrl?: boolean;
}

const cache = new Map<ProviderId, CacheEntry>();
const inflight = new Map<ProviderId, Promise<ModelInfo[]>>();

function normalizeModels(providerId: ProviderId, data: unknown): ModelInfo[] {
  const defaultContext = PROVIDER_DEFAULT_CONTEXT[providerId] ?? 128_000;
  const defaultCaps: ModelInfo["capabilities"] = {
    context_window: defaultContext,
    score: 50,
    supports_thinking: false,
    supports_vision: false,
    supports_images: false,
    aliases: [],
  };

  try {
    switch (providerId) {
      case "openai": {
        const models = (data as { data: Array<{ id: string }> }).data ?? [];
        return models.map((m) => ({
          id: m.id,
          provider: "openai" as ProviderId,
          display_name: m.id,
          capabilities: { ...defaultCaps },
        }));
      }

      case "anthropic": {
        const models =
          (data as { data: Array<{ id: string; display_name?: string }> })
            .data ?? [];
        return models.map((m) => ({
          id: m.id,
          provider: "anthropic" as ProviderId,
          display_name: m.display_name ?? m.id,
          capabilities: { ...defaultCaps },
        }));
      }

      case "google": {
        const models =
          (
            data as {
              models: Array<{
                name: string;
                displayName?: string;
                inputTokenLimit?: number;
              }>;
            }
          ).models ?? [];
        return models.map((m) => ({
          id: m.name.replace(/^models\//, ""),
          provider: "google" as ProviderId,
          display_name: m.displayName ?? m.name.replace(/^models\//, ""),
          capabilities: {
            ...defaultCaps,
            context_window: m.inputTokenLimit ?? defaultContext,
          },
        }));
      }

      case "openrouter": {
        const models =
          (
            data as {
              data: Array<{
                id: string;
                name?: string;
                context_length?: number;
              }>;
            }
          ).data ?? [];
        return models.map((m) => ({
          id: m.id,
          provider: "openrouter" as ProviderId,
          display_name: m.name ?? m.id,
          capabilities: {
            ...defaultCaps,
            context_window: m.context_length ?? defaultContext,
          },
        }));
      }

      default:
        return [];
    }
  } catch (err) {
    logger.warn("Failed to normalize models from provider", {
      provider: providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function fetchFromProvider(
  providerId: ProviderId,
  apiKey: string,
  baseUrl?: string,
  options: DiscoverModelsOptions = {},
): Promise<ModelInfo[]> {
  const validatedBaseUrl =
    providerId === "custom" && baseUrl
      ? validateCustomApiUrl(baseUrl, options.allowInsecureCustomUrl === true)
      : baseUrl;
  const endpoint = validatedBaseUrl
    ? `${validatedBaseUrl.replace(/\/$/, "")}/models`
    : PROVIDER_API_ENDPOINTS[providerId];

  if (!endpoint) return [];

  const url = endpoint;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (providerId === "google") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (providerId === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return normalizeModels(providerId, data);
}

export async function discoverModels(
  providerId: ProviderId,
  apiKey: string,
  baseUrl?: string,
  options: DiscoverModelsOptions = {},
): Promise<ModelInfo[]> {
  const cached = cache.get(providerId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }

  // Promise memoization — prevent concurrent duplicate fetches
  const existing = inflight.get(providerId);
  if (existing) return existing;

  const promise = fetchFromProvider(providerId, apiKey, baseUrl, options)
    .then((models) => {
      cache.set(providerId, { models, fetchedAt: Date.now() });
      inflight.delete(providerId);
      return models;
    })
    .catch((err) => {
      logger.warn("Model discovery failed for provider", {
        provider: providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      inflight.delete(providerId);
      return [] as ModelInfo[];
    });

  inflight.set(providerId, promise);
  return promise;
}

export function getCachedModels(providerId: ProviderId): ModelInfo[] {
  return cache.get(providerId)?.models ?? [];
}

export function getAllCachedModels(): ModelInfo[] {
  return Array.from(cache.values()).flatMap((e) => e.models);
}

/** Exposed for testing only — clears the in-memory cache. */
export function clearDiscoveryCache(): void {
  cache.clear();
  inflight.clear();
}

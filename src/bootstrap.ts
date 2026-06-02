import { loadConfig } from "./config";
import { ConversationStore } from "./memory/conversations";
import { createModelGateway } from "./providers/model-gateway";
import { createProviderRegistry } from "./providers/registry";
import { BabServer, toToolError } from "./server";
import { generateSkillContent } from "./skills/generator";
import { regenerateSkills } from "./skills/index";
import { ALWAYS_LOADED_TOOLS, buildToolManifest } from "./tools/manifest";
import { createToolsTool } from "./tools/tools";
import { configureLogging, logger } from "./utils/logger";

export const CORE_TOOL_NAMES = [
  "analyze",
  "challenge",
  "chat",
  "codereview",
  "consensus",
  "debug",
  "delegate",
  "docgen",
  "list_models",
  "planner",
  "precommit",
  "refactor",
  "secaudit",
  "testgen",
  "thinkdeep",
  "tracer",
  "version",
] as const;

// Additional tools registered only in lazy mode
export const LAZY_MODE_TOOL_NAMES = ["tools"] as const;

export function parseDisabledTools(raw?: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function registerCoreTools(
  server: BabServer,
  config: Awaited<ReturnType<typeof loadConfig>>,
): void {
  const providerRegistry = createProviderRegistry(config);
  const modelGateway = createModelGateway(providerRegistry, config);
  const conversationStore = new ConversationStore();
  const toolContext = {
    conversationStore,
    modelGateway,
    providerRegistry,
  };

  const enabled = parseDisabledTools(config.env.BAB_ENABLED_TOOLS);
  const disabled = parseDisabledTools(config.env.BAB_DISABLED_TOOLS);
  const manifest = buildToolManifest(toolContext, providerRegistry, config);

  if (enabled.size > 0) {
    for (const name of [...manifest.keys()]) {
      if (!enabled.has(name)) {
        logger.info("Tool omitted via BAB_ENABLED_TOOLS", { tool: name });
        manifest.delete(name);
      }
    }
  }

  // Filter disabled tools out of the manifest entirely
  for (const name of disabled) {
    if (manifest.has(name)) {
      logger.info("Tool disabled via BAB_DISABLED_TOOLS", { tool: name });
      manifest.delete(name);
    }
  }

  server.setManifest(manifest);
  server.config = config;

  // Log effective persistence config at startup
  const defaultTools = [...manifest.values()]
    .filter((e) => e.persist === "default")
    .map((e) => e.name);
  const optionalEnabled = [...(config.persistence?.enabledTools ?? [])].filter(
    (t) => {
      const entry = manifest.get(t);
      return entry?.persist === "optional";
    },
  );
  const disabledFromDefaults = [
    ...(config.persistence?.disabledTools ?? []),
  ].filter((t) => manifest.get(t)?.persist === "default");
  logger.debug("Persistence config", {
    enabled: config.persistence?.enabled,
    default_tools: defaultTools,
    optional_enabled: optionalEnabled,
    disabled: disabledFromDefaults,
  });

  if (config.lazyTools) {
    // Lazy mode: register always-loaded tools + the tools meta-tool
    for (const entry of manifest.values()) {
      if (ALWAYS_LOADED_TOOLS.has(entry.name)) {
        server.registerTool(entry.factory());
      }
    }
    server.registerTool(createToolsTool(server));
    logger.info("Lazy tool loading enabled", {
      always_loaded: Array.from(ALWAYS_LOADED_TOOLS),
    });
  } else {
    // Eager mode: register all tools from manifest
    for (const entry of manifest.values()) {
      server.registerTool(entry.factory());
    }
  }
}

function installSignalHandlers(server: BabServer): () => void {
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Received shutdown signal", { signal });
    void server
      .close()
      .catch((error: unknown) => {
        logger.error("Failed to close MCP server cleanly", {
          error: toToolError(error),
        });
      })
      .finally(() => {
        process.exit(0);
      });
  };

  const handleSigint = () => shutdown("SIGINT");
  const handleSigterm = () => shutdown("SIGTERM");

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  return () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
}

export async function main(): Promise<void> {
  const config = await loadConfig();
  if (config.env.BAB_LOG_LEVEL) {
    process.env.BAB_LOG_LEVEL = config.env.BAB_LOG_LEVEL;
  }
  await configureLogging();
  const server = new BabServer();
  registerCoreTools(server, config);
  const removeSignalHandlers = installSignalHandlers(server);

  try {
    await regenerateSkills(() => generateSkillContent(config));
  } catch (error) {
    logger.warn("Failed to auto-update agent skills on startup", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await server.connect();
    logger.info("Bab MCP server running on stdio", {
      config_dir: config.paths.baseDir,
    });
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
}

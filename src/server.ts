import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  type GetPromptRequest,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool as McpTool,
  type TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import type { BabConfig } from "./config";
import { persistReport } from "./memory/persistence";
import { getPrompt, listPrompts } from "./prompts/slash-commands";
import type { ToolManifestEntry } from "./tools/manifest";
import {
  type Result,
  type ToolError,
  ToolErrorSchema,
  type ToolOutput,
} from "./types";
import { logger } from "./utils/logger";
import { VERSION } from "./version";

const SERVER_INFO = {
  name: "bab",
  version: VERSION,
} as const;

const EmptyInputSchema = z.object({});

export interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodObject;
  execute: (
    args: Record<string, unknown>,
  ) => Promise<Result<ToolOutput, ToolError>> | Result<ToolOutput, ToolError>;
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof z.ZodError) {
    return {
      type: "validation",
      message: "Invalid tool arguments",
      details: error.flatten(),
      retryable: false,
    };
  }

  const parsedToolError = ToolErrorSchema.safeParse(error);

  if (parsedToolError.success) {
    return parsedToolError.data;
  }

  if (error instanceof Error) {
    const details: Record<string, unknown> = { name: error.name };
    if (process.env.BAB_LOG_LEVEL?.toLowerCase() === "debug") {
      details.stack = error.stack;
    }
    return {
      type: "execution",
      message: error.message,
      details,
      retryable: false,
    };
  }

  return {
    type: "unknown",
    message: "Unknown tool execution failure",
    details: error,
    retryable: false,
  };
}

function toTextContent(payload: ToolOutput | ToolError): TextContent[] {
  return [
    {
      type: "text",
      text: JSON.stringify(payload),
    },
  ];
}

function toMcpSchema(schema?: z.ZodObject): McpTool["inputSchema"] {
  return (schema ?? EmptyInputSchema).toJSONSchema() as McpTool["inputSchema"];
}

function toMcpTool(tool: RegisteredTool): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toMcpSchema(tool.inputSchema),
    outputSchema: tool.outputSchema
      ? toMcpSchema(tool.outputSchema)
      : undefined,
  };
}

export class BabServer {
  readonly toolRegistry = new Map<string, RegisteredTool>();
  readonly protocolServer: Server;
  private _manifest = new Map<string, ToolManifestEntry>();
  config: BabConfig | undefined;

  get manifest(): ReadonlyMap<string, ToolManifestEntry> {
    return this._manifest;
  }

  setManifest(manifest: Map<string, ToolManifestEntry>): void {
    this._manifest = manifest;
  }

  private isConnected = false;
  private isClosing = false;
  private readonly loadingPromises = new Map<string, Promise<RegisteredTool>>();

  shouldPersistTool(toolName: string): boolean {
    const persistence = this.config?.persistence;
    if (!persistence?.enabled) return false;
    const entry = this.manifest.get(toolName);
    if (!entry) return false;
    if (entry.persist === "never") return false;
    if (entry.persist === "default") {
      return !persistence.disabledTools.has(toolName);
    }
    // optional
    return persistence.enabledTools.has(toolName);
  }

  constructor() {
    this.protocolServer = new Server(SERVER_INFO, {
      capabilities: {
        prompts: {},
        tools: { listChanged: true },
      },
    });

    this.protocolServer.onerror = (error) => {
      logger.error("MCP protocol error", {
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack,
        },
      });
    };

    this.protocolServer.onclose = () => {
      this.isConnected = false;
      logger.info("MCP server closed");
    };

    this.protocolServer.setRequestHandler(ListToolsRequestSchema, async () =>
      this.handleListToolsRequest(),
    );
    this.protocolServer.setRequestHandler(
      CallToolRequestSchema,
      async (request) => this.handleCallToolRequest(request),
    );
    this.protocolServer.setRequestHandler(ListPromptsRequestSchema, async () =>
      this.handleListPromptsRequest(),
    );
    this.protocolServer.setRequestHandler(
      GetPromptRequestSchema,
      async (request) => this.handleGetPromptRequest(request),
    );
  }

  registerTool(tool: RegisteredTool): void {
    if (this.toolRegistry.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }

    this.toolRegistry.set(tool.name, tool);
  }

  async sendToolListChanged(): Promise<void> {
    if (!this.isConnected) return;
    await this.protocolServer.sendToolListChanged();
  }

  async loadFromManifest(name: string): Promise<RegisteredTool | null> {
    const existing = this.toolRegistry.get(name);
    if (existing) return existing;

    const inFlight = this.loadingPromises.get(name);
    if (inFlight) return inFlight;

    const entry = this.manifest.get(name);
    if (!entry) return null;

    const promise = Promise.resolve()
      .then(() => entry.factory())
      .then((tool) => {
        this.registerTool(tool);
        return tool;
      })
      .catch((error) => {
        logger.error("Failed to load tool from manifest", {
          tool: name,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        this.loadingPromises.delete(name);
      });

    this.loadingPromises.set(name, promise as Promise<RegisteredTool>);
    const tool = await promise;
    if (tool) {
      logger.info("Lazy tool loaded", { tool: name });
      void this.sendToolListChanged();
    }
    return tool;
  }

  /** Load multiple tools from manifest and send a single listChanged notification. */
  async batchLoadFromManifest(names: string[]): Promise<RegisteredTool[]> {
    const results = await Promise.all(
      names.map(async (name) => {
        const existing = this.toolRegistry.get(name);
        if (existing) return existing;

        const inFlight = this.loadingPromises.get(name);
        if (inFlight) return inFlight;

        const entry = this._manifest.get(name);
        if (!entry) return null;

        const promise = Promise.resolve()
          .then(() => entry.factory())
          .then((tool) => {
            this.registerTool(tool);
            return tool;
          })
          .catch((error) => {
            logger.error("Failed to load tool from manifest", {
              tool: name,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
          .finally(() => {
            this.loadingPromises.delete(name);
          });

        this.loadingPromises.set(name, promise as Promise<RegisteredTool>);
        return promise;
      }),
    );

    const loaded = results.filter((t): t is RegisteredTool => t !== null);
    if (loaded.length > 0) {
      for (const tool of loaded) {
        logger.info("Lazy tool loaded (batch)", { tool: tool.name });
      }
      void this.sendToolListChanged();
    }
    return loaded;
  }

  async handleListPromptsRequest(): Promise<ListPromptsResult> {
    return { prompts: listPrompts() };
  }

  async handleGetPromptRequest(
    request: GetPromptRequest,
  ): Promise<GetPromptResult> {
    const { name, arguments: args } = request.params;
    logger.info("Prompt requested", { prompt: name });
    return getPrompt(name, args);
  }

  async handleListToolsRequest(): Promise<ListToolsResult> {
    return {
      tools: Array.from(this.toolRegistry.values(), toMcpTool),
    };
  }

  async handleCallToolRequest(
    request: CallToolRequest,
  ): Promise<CallToolResult> {
    const { arguments: rawArguments = {}, name } = request.params;
    logger.info("Tool call received", { tool: name });

    let tool = this.toolRegistry.get(name);

    if (!tool) {
      const loaded = await this.loadFromManifest(name);
      if (!loaded) {
        logger.warn("Unknown tool requested", { tool: name });
        return {
          content: toTextContent({
            type: "not_found",
            message: `Unknown tool: ${name}`,
            retryable: false,
          }),
          isError: true,
        };
      }
      tool = loaded;
    }

    const startedAt = Date.now();

    try {
      const parsedArguments = tool.inputSchema.parse(rawArguments) as Record<
        string,
        unknown
      >;
      const result = await tool.execute(parsedArguments);
      const durationMs = Date.now() - startedAt;

      if (result.ok) {
        logger.info("Tool call succeeded", {
          tool: name,
          duration_ms: durationMs,
        });

        if (this.shouldPersistTool(name)) {
          const inputText =
            typeof rawArguments.step === "string"
              ? rawArguments.step
              : typeof rawArguments.findings === "string"
                ? rawArguments.findings
                : typeof rawArguments.question === "string"
                  ? rawArguments.question
                  : typeof rawArguments.prompt === "string"
                    ? rawArguments.prompt
                    : "";
          const continuationId =
            typeof result.value.metadata?.continuation_id === "string"
              ? result.value.metadata.continuation_id
              : typeof rawArguments.continuation_id === "string"
                ? rawArguments.continuation_id
                : `${name}-${Date.now()}`;
          void persistReport({
            toolName: name,
            continuationId,
            inputText,
            content:
              typeof result.value.content === "string"
                ? result.value.content
                : JSON.stringify(result.value),
            models: [],
            projectRoot: process.cwd(),
          });
        }

        return {
          content: toTextContent(result.value),
          isError: false,
        };
      }

      logger.warn("Tool call returned error", {
        tool: name,
        duration_ms: durationMs,
      });
      return {
        content: toTextContent(result.error),
        isError: true,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      logger.error("Tool call threw exception", {
        tool: name,
        duration_ms: durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content: toTextContent(toToolError(error)),
        isError: true,
      };
    }
  }

  async connect(
    transport = new StdioServerTransport(),
  ): Promise<StdioServerTransport> {
    await this.protocolServer.connect(transport);
    this.isConnected = true;
    logger.info("MCP server connected", {
      tool_count: this.toolRegistry.size,
    });

    return transport;
  }

  async close(): Promise<void> {
    if (!this.isConnected || this.isClosing) {
      return;
    }

    this.isClosing = true;

    try {
      await this.protocolServer.close();
    } finally {
      this.isClosing = false;
      this.isConnected = false;
    }
  }
}

if (import.meta.main) {
  const { main } = await import("./bootstrap");
  main().catch((error: unknown) => {
    logger.error("Failed to start MCP server", {
      error: toToolError(error),
    });
    process.exit(1);
  });
}

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Only forward variables the server process genuinely needs to run.
// All provider keys and BAB_* vars must be passed explicitly via the env
// parameter — this keeps tests hermetic regardless of the developer's shell.
const ENV_PASSTHROUGH = new Set(["PATH", "TMPDIR", "TERM", "LANG"]);

function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        ENV_PASSTHROUGH.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export class BabTestHarness {
  private readonly client = new Client({
    name: "bab-test-harness",
    version: "0.1.0",
  });

  constructor(
    private readonly transport: StdioClientTransport,
    private readonly homeDirectory: string,
  ) {}

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<ListToolsResult> {
    return this.client.listTools();
  }

  async listPrompts(): Promise<ListPromptsResult> {
    return this.client.listPrompts();
  }

  async getPrompt(
    params: GetPromptRequest["params"],
  ): Promise<GetPromptResult> {
    return this.client.getPrompt(params) as Promise<GetPromptResult>;
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.client.callTool(
      params,
      CallToolResultSchema,
    ) as Promise<CallToolResult>;
  }

  async close(): Promise<void> {
    await this.client.close();
    await rm(this.homeDirectory, { force: true, recursive: true });
  }
}

export async function createBabTestHarness(
  pluginDirectories: string[] = [],
  env: Record<string, string> = {},
): Promise<BabTestHarness> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "bab-harness-home-"));
  const pluginsHome = join(homeDirectory, ".config", "bab", "plugins");

  await mkdir(pluginsHome, { recursive: true });

  for (const pluginDirectory of pluginDirectories) {
    const pluginName = basename(pluginDirectory);

    if (!pluginName) {
      continue;
    }

    await cp(pluginDirectory, join(pluginsHome, pluginName), {
      recursive: true,
    });
  }

  const transport = new StdioClientTransport({
    args: ["run", "src/server.ts"],
    command: "bun",
    cwd: process.cwd(),
    env: {
      ...baseEnv(),
      ...env,
      HOME: homeDirectory,
    },
    stderr: "pipe",
  });
  const harness = new BabTestHarness(transport, homeDirectory);

  await harness.connect();

  return harness;
}

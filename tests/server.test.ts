import { describe, expect, test } from "bun:test";
import {
  type CallToolResult,
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { parseDisabledTools } from "../src/bootstrap";
import { BabServer } from "../src/server";

type ToolContent = CallToolResult["content"][number];
type TextBlock = Extract<ToolContent, { type: "text" }>;

function expectTextContent(content: ToolContent | undefined): string {
  expect(content?.type).toBe("text");

  if (!content || content.type !== "text") {
    throw new Error("Expected text content");
  }

  return (content as TextBlock).text;
}

describe("BabServer", () => {
  test("returns an empty tool list before registration", async () => {
    const server = new BabServer();
    const result = await server.handleListToolsRequest();

    expect(ListToolsResultSchema.parse(result)).toEqual({
      tools: [],
    });
  });

  test("lists registered tools with JSON schemas", async () => {
    const server = new BabServer();

    server.registerTool({
      name: "echo",
      description: "Echo a message",
      inputSchema: z.object({
        message: z.string(),
      }),
      execute: async () => ({
        ok: true,
        value: {
          content: "unused",
          content_type: "text",
          metadata: {},
          status: "success",
        },
      }),
    });

    const result = await server.handleListToolsRequest();
    const parsed = ListToolsResultSchema.parse(result);

    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.name).toBe("echo");
    expect(parsed.tools[0]?.description).toBe("Echo a message");
    expect(parsed.tools[0]?.inputSchema.type).toBe("object");
    expect(parsed.tools[0]?.inputSchema.properties).toHaveProperty("message");
    expect(parsed.tools[0]?.inputSchema.required).toContain("message");
  });

  test("routes tool calls and serializes ToolOutput as text content", async () => {
    const server = new BabServer();

    server.registerTool({
      name: "echo",
      description: "Echo a message",
      inputSchema: z.object({
        message: z.string(),
      }),
      execute: async (args) => ({
        ok: true,
        value: {
          content: `echo:${String(args.message)}`,
          content_type: "text",
          metadata: {
            called: true,
          },
          status: "success",
        },
      }),
    });

    const result = await server.handleCallToolRequest({
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          message: "hello",
        },
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBeFalse();
    expect(parsed.content).toHaveLength(1);
    expect(JSON.parse(expectTextContent(parsed.content[0]))).toEqual({
      content: "echo:hello",
      content_type: "text",
      metadata: {
        called: true,
      },
      status: "success",
    });
  });

  test("returns structured errors when tool execution fails", async () => {
    const server = new BabServer();

    server.registerTool({
      name: "fail",
      description: "Always fails",
      inputSchema: z.object({}),
      execute: async () => ({
        error: {
          type: "execution" as const,
          message: "Something went wrong",
          retryable: false,
        },
        ok: false as const,
      }),
    });

    const result = await server.handleCallToolRequest({
      method: "tools/call",
      params: {
        name: "fail",
        arguments: {},
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBeTrue();
    expect(JSON.parse(expectTextContent(parsed.content[0]))).toMatchObject({
      type: "execution",
      message: "Something went wrong",
    });
  });

  test("returns structured errors for unknown tools", async () => {
    const server = new BabServer();
    const result = await server.handleCallToolRequest({
      method: "tools/call",
      params: {
        name: "missing",
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBeTrue();
    expect(JSON.parse(expectTextContent(parsed.content[0]))).toEqual({
      type: "not_found",
      message: "Unknown tool: missing",
      retryable: false,
    });
  });
});

describe("parseDisabledTools", () => {
  test("returns empty set for undefined", () => {
    expect(parseDisabledTools(undefined)).toEqual(new Set());
  });

  test("returns empty set for empty string", () => {
    expect(parseDisabledTools("")).toEqual(new Set());
  });

  test("parses comma-separated tool names", () => {
    expect(parseDisabledTools("delegate,chat")).toEqual(
      new Set(["delegate", "chat"]),
    );
  });

  test("trims whitespace and lowercases", () => {
    expect(parseDisabledTools(" Delegate , CHAT ")).toEqual(
      new Set(["delegate", "chat"]),
    );
  });

  test("ignores empty segments from trailing commas", () => {
    expect(parseDisabledTools("delegate,,chat,")).toEqual(
      new Set(["delegate", "chat"]),
    );
  });
});

import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

import {
  createResultSchema,
  DelegateEventSchema,
  ModelCapabilitiesSchema,
  PluginManifestSchema,
  RoleDefinitionSchema,
  ToolErrorSchema,
  ToolOutputSchema,
} from "../src/types";

describe("ToolOutputSchema", () => {
  test("rejects unsupported status values", () => {
    expect(() =>
      ToolOutputSchema.parse({
        status: "partial_success",
      }),
    ).toThrow();
  });
});

describe("createResultSchema", () => {
  test("supports success and error variants", () => {
    const schema = createResultSchema(ToolOutputSchema, ToolErrorSchema);

    expect(
      schema.parse({
        ok: true,
        value: {
          content: "done",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        content: "done",
        content_type: "text",
        metadata: {},
        status: "success",
      },
    });

    expect(
      schema.parse({
        ok: false,
        error: {
          type: "timeout",
          message: "CLI timed out",
        },
      }),
    ).toEqual({
      error: {
        message: "CLI timed out",
        retryable: false,
        type: "timeout",
      },
      ok: false,
    });
  });
});

describe("DelegateEventSchema", () => {
  test("rejects invalid progress percentages", () => {
    expect(() =>
      DelegateEventSchema.parse({
        type: "progress",
        run_id: "run-123",
        provider_id: "claude",
        timestamp: "2026-03-10T12:00:00.000Z",
        message: "working",
        percentage: 101,
      }),
    ).toThrow();
  });

  test("parses error events with shared metadata", () => {
    expect(
      DelegateEventSchema.parse({
        type: "error",
        run_id: "run-123",
        provider_id: "claude",
        timestamp: "2026-03-10T12:00:00.000Z",
        error: {
          type: "execution",
          message: "non-zero exit",
        },
      }),
    ).toEqual({
      type: "error",
      run_id: "run-123",
      provider_id: "claude",
      timestamp: "2026-03-10T12:00:00.000Z",
      error: {
        type: "execution",
        message: "non-zero exit",
        retryable: false,
      },
    });
  });
});

describe("RoleDefinitionSchema", () => {
  test("supports custom role inheritance with args", () => {
    expect(
      RoleDefinitionSchema.parse({
        name: "research",
        inherits: "planner",
        prompt_file: "prompts/research.txt",
        args: {
          thinking_depth: "high",
          max_steps: 4,
        },
      }),
    ).toEqual({
      name: "research",
      inherits: "planner",
      prompt_file: "prompts/research.txt",
      args: {
        thinking_depth: "high",
        max_steps: 4,
      },
    });
  });
});

describe("PluginManifestSchema", () => {
  test("rejects invalid manifest identifiers", () => {
    expect(() =>
      PluginManifestSchema.parse({
        id: "Codex",
        name: "Codex",
        version: "1.0.0",
        command: "codex",
        roles: ["default"],
      }),
    ).toThrow();
  });

  test("applies manifest defaults", () => {
    expect(
      PluginManifestSchema.parse({
        id: "codex",
        name: "Codex",
        version: "1.0.0",
        command: "codex",
        roles: ["default"],
      }),
    ).toEqual({
      id: "codex",
      name: "Codex",
      version: "1.0.0",
      command: "codex",
      roles: ["default"],
      capabilities: {
        output_format: "text",
        supports_cancellation: false,
        supports_images: false,
        supports_streaming: false,
        supports_working_directory: true,
      },
      delegate_api_version: 1,
    });
  });
});

describe("ModelCapabilitiesSchema", () => {
  test("rejects invalid metadata values", () => {
    expect(() =>
      ModelCapabilitiesSchema.parse({
        context_window: 0,
        supports_thinking: true,
        score: -1,
      }),
    ).toThrow();
  });
});

describe("zod v4 JSON schema integration", () => {
  test("generates JSON schema for tool outputs", () => {
    const jsonSchema = z.toJSONSchema(ToolOutputSchema);

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toHaveProperty("status");
    expect(jsonSchema.properties).toHaveProperty("content_type");
  });

  test("supports generic result schemas", () => {
    const GenericResultSchema = createResultSchema(
      z.object({
        step: z.string(),
      }),
      ToolErrorSchema,
    );

    const jsonSchema = z.toJSONSchema(GenericResultSchema);

    expect(jsonSchema.oneOf).toBeDefined();
  });
});

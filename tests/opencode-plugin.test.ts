import { describe, expect, test } from "bun:test";

import adapter, { parseOpenCodeJsonOutput } from "../plugins/opencode/adapter";

describe("OpenCode plugin parser", () => {
  test("extracts text events and step metadata", () => {
    const parsed = parseOpenCodeJsonOutput(
      [
        JSON.stringify({
          sessionID: "opencode-session",
          type: "step_start",
        }),
        JSON.stringify({
          part: {
            text: "ok",
          },
          sessionID: "opencode-session",
          type: "text",
        }),
        JSON.stringify({
          part: {
            cost: 0.01,
            reason: "stop",
            tokens: {
              input: 12,
              output: 1,
            },
          },
          sessionID: "opencode-session",
          type: "step_finish",
        }),
      ].join("\n"),
    );

    expect(parsed.content).toBe("ok");
    expect(parsed.metadata.session_id).toBe("opencode-session");
    expect(parsed.metadata.tokens).toEqual({
      input: 12,
      output: 1,
    });
    expect(parsed.metadata.cost).toBe(0.01);
  });

  test("falls back to error messages", () => {
    const parsed = parseOpenCodeJsonOutput(
      JSON.stringify({
        error: {
          data: {
            message: "OpenCode auth error",
          },
          name: "APIError",
        },
        type: "error",
      }),
    );

    expect(parsed.content).toBe("OpenCode auth error");
    expect(parsed.metadata.errors).toEqual(["OpenCode auth error"]);
  });

  test("describes the available OpenCode plugin roles", () => {
    expect(adapter.discover()).toEqual({
      command: "opencode",
      id: "opencode",
      name: "OpenCode CLI",
      output_format: "jsonl",
      roles: ["default", "planner", "codereviewer", "researcher"],
    });
  });

  test("buildCommand resolves OpenCode model from delegate env", () => {
    const command = adapter.buildCommand({
      env: {
        OPENCODE_MODEL: "openai/gpt-5",
        PATH: "/nonexistent",
      },
      prompt: "User task",
      role: {
        args: {},
        name: "default",
        prompt: "Role prompt",
      },
    });

    expect(command.env.OPENCODE_MODEL).toBe("openai/gpt-5");
    expect(command.args).toContain("--model");
    expect(command.args).toContain("openai/gpt-5");
  });
});

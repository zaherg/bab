import { afterEach, describe, expect, test } from "bun:test";

import {
  getPrompt,
  listPrompts,
  PROMPT_NAMES,
} from "../src/prompts/slash-commands";
import { type BabTestHarness, createBabTestHarness } from "./harness";

const activeHarnesses: BabTestHarness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    await activeHarnesses.pop()?.close();
  }
});

describe("listPrompts", () => {
  test("returns all registered prompts", () => {
    const prompts = listPrompts();

    expect(prompts.length).toBe(15);
    expect(prompts.map((p) => p.name)).toEqual(PROMPT_NAMES);
  });

  test("each prompt has name, description, and args argument", () => {
    for (const prompt of listPrompts()) {
      expect(prompt.name).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      expect(prompt.arguments).toHaveLength(1);
      expect(prompt.arguments?.[0].name).toBe("args");
    }
  });

  test("excludes version and list_models", () => {
    const names = listPrompts().map((p) => p.name);

    expect(names).not.toContain("version");
    expect(names).not.toContain("list_models");
  });

  test("includes expected slash command names", () => {
    const names = listPrompts().map((p) => p.name);

    expect(names).toContain("chat");
    expect(names).toContain("review");
    expect(names).toContain("think");
    expect(names).toContain("delegate");
    expect(names).toContain("consensus");
  });
});

describe("getPrompt", () => {
  test("throws for unknown prompt", () => {
    expect(() => getPrompt("nonexistent", undefined)).toThrow(
      "Unknown prompt: nonexistent",
    );
  });

  test("simple prompt with args returns tool call instruction", () => {
    const result = getPrompt("chat", { args: "explain monads" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("chat");
    expect(text).toContain("explain monads");
  });

  test("simple prompt without args asks user for input", () => {
    const result = getPrompt("chat", undefined);

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("Ask the user");
  });

  test("workflow prompt includes step setup instructions", () => {
    const result = getPrompt("review", { args: "check auth module" });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("codereview");
    expect(text).toContain("step_number: 1");
    expect(text).toContain("findings");
    expect(text).toContain("next_step_required: true");
    expect(text).toContain("check auth module");
  });

  test("multimodel prompt includes consensus guidance", () => {
    const result = getPrompt("consensus", { args: "should we use GraphQL?" });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("consensus");
    expect(text).toContain("should we use GraphQL?");
    expect(text).toContain("multi-model");
    expect(text).toContain("findings");
    expect(text).toContain("models");
    expect(text).toContain("at least two");
    expect(text).not.toContain("auto-select");
  });

  test("MCP prompt round-trip exposes schema-complete workflow instructions", async () => {
    const harness = await createBabTestHarness();
    activeHarnesses.push(harness);

    const prompts = await harness.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain("review");

    const result = await harness.getPrompt({
      arguments: { args: "check auth module" },
      name: "review",
    });
    const text = result.messages[0]?.content;

    if (!text || text.type !== "text") throw new Error("Expected text prompt");
    expect(text.text).toContain("codereview");
    expect(text.text).toContain("findings");
    expect(text.text).toContain("step_number: 1");
  });

  test("delegation prompt includes agent parsing guidance", () => {
    const result = getPrompt("delegate", { args: "codex fix the tests" });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("delegate");
    expect(text).toContain("cli_name");
    expect(text).toContain("codex fix the tests");
  });

  test("think maps to thinkdeep tool", () => {
    const result = getPrompt("think", { args: "analyze race condition" });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("thinkdeep");
  });

  test("review maps to codereview tool", () => {
    const result = getPrompt("review", { args: "" });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("codereview");
  });

  test("all prompts return valid GetPromptResult structure", () => {
    for (const name of PROMPT_NAMES) {
      const result = getPrompt(name, { args: "test input" });

      expect(result.description).toBeTruthy();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect((result.messages[0].content as { type: string }).type).toBe(
        "text",
      );
      expect(
        (result.messages[0].content as { text: string }).text.length,
      ).toBeGreaterThan(0);
    }
  });
});

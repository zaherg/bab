import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BabTestHarness, createBabTestHarness } from "./harness";

const activeHarnesses: BabTestHarness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    await activeHarnesses.pop()?.close();
  }
});

function parseToolPayload(
  result: Awaited<ReturnType<BabTestHarness["callTool"]>>,
) {
  const [content] = result.content;

  expect(content?.type).toBe("text");

  if (!content || content.type !== "text") {
    throw new Error("Expected text content");
  }

  return JSON.parse(content.text) as {
    content: string;
    metadata: Record<string, unknown>;
    status: string;
  };
}

async function createOpenCodeStub(binDirectory: string): Promise<void> {
  const stubPath = join(binDirectory, "opencode");
  const source = [
    "#!/usr/bin/env bun",
    "const args = Bun.argv.slice(2);",
    "const captureDirectory = process.env.OPENCODE_CAPTURE_DIR ?? '.';",
    "if (args[0] === 'auth' && args[1] === 'list') {",
    "  console.log('●  DeepSeek api');",
    "  process.exit(0);",
    "}",
    "await Bun.write(captureDirectory + '/argv.json', JSON.stringify(args));",
    "const prompt = args[1] ?? '';",
    "const content = prompt.includes('OPENCODE_RESEARCHER_ROLE') ? 'research-path' : 'missing-role';",
    "console.log(JSON.stringify({ type: 'step_start', sessionID: 'opencode-session' }));",
    "console.log(JSON.stringify({ type: 'text', sessionID: 'opencode-session', part: { text: content } }));",
    "console.log(JSON.stringify({ type: 'step_finish', sessionID: 'opencode-session', part: { tokens: { input: 9, output: 4 }, cost: 0.02, reason: 'stop' } }));",
    "process.exit(5);",
  ].join("\n");

  await writeFile(stubPath, source);
  await chmod(stubPath, 0o755);
}

describe("OpenCode plugin integration", () => {
  test("recovers parseable JSON output and prepends role prompts", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bab-opencode-e2e-"));
    const binDirectory = join(sandbox, "bin");
    const captureDirectory = join(sandbox, "capture");

    await mkdir(binDirectory, { recursive: true });
    await mkdir(captureDirectory, { recursive: true });
    await createOpenCodeStub(binDirectory);

    const harness = await createBabTestHarness(
      [join(process.cwd(), "plugins/opencode")],
      {
        OPENCODE_CAPTURE_DIR: captureDirectory,
        BAB_OPENCODE_MODEL: "deepseek/deepseek-chat",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      },
    );

    activeHarnesses.push(harness);

    const result = await harness.callTool({
      arguments: {
        cli_name: "opencode",
        prompt: "Research the codebase",
        role: "researcher",
      },
      name: "delegate",
    });
    const payload = parseToolPayload(result);
    const argv = JSON.parse(
      await readFile(join(captureDirectory, "argv.json"), "utf8"),
    ) as string[];

    expect(result.isError).toBeFalse();
    expect(payload.status).toBe("success");
    expect(payload.content).toBe("research-path");
    expect(payload.metadata.session_id).toBe("opencode-session");
    expect(payload.metadata.tokens).toEqual({
      input: 9,
      output: 4,
    });
    expect(payload.metadata.exit_code).toBe(5);
    expect(argv[0]).toBe("run");
    expect(argv[1]).toContain("OPENCODE_RESEARCHER_ROLE");
    expect(argv[1]).toContain("Research the codebase");
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("--model");
    expect(argv).toContain("deepseek/deepseek-chat");
    expect(argv).toContain("--variant");
    expect(argv).toContain("high");
  });
});

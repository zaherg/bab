import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BabConfig } from "../../src/config";
import { ConversationStore } from "../../src/memory/conversations";
import { ModelGateway } from "../../src/providers/model-gateway";
import { ProviderRegistry } from "../../src/providers/registry";
import type { RegisteredTool } from "../../src/server";
import { createAnalyzeTool } from "../../src/tools/analyze";
import type { ToolContext } from "../../src/tools/base";
import { createChallengeTool } from "../../src/tools/challenge";
import { createChatTool } from "../../src/tools/chat";
import { createCodeReviewTool } from "../../src/tools/codereview";
import { createConsensusTool } from "../../src/tools/consensus";
import { createDebugTool } from "../../src/tools/debug";
import { createDocgenTool } from "../../src/tools/docgen";
import { createListModelsTool } from "../../src/tools/listmodels";
import { createPlannerTool } from "../../src/tools/planner";
import { createPrecommitTool } from "../../src/tools/precommit";
import { createRefactorTool } from "../../src/tools/refactor";
import { createSecauditTool } from "../../src/tools/secaudit";
import { createTestgenTool } from "../../src/tools/testgen";
import { createThinkDeepTool } from "../../src/tools/thinkdeep";
import { createTracerTool } from "../../src/tools/tracer";
import { createVersionTool } from "../../src/tools/version";

const MODEL = "gpt-4o-mini";
const MODEL_2 = "gpt-4o";
const TIMEOUT_MS = 60_000;

function buildConfig(): BabConfig {
  const baseDir = mkdtempSync(join(tmpdir(), "bab-phase2-"));
  return {
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    },
    paths: {
      baseDir,
      envFile: join(baseDir, "env"),
      pluginsDir: join(baseDir, "plugins"),
      promptsDir: join(baseDir, "prompts"),
    },
  };
}

function buildContext(config: BabConfig): ToolContext {
  const providerRegistry = new ProviderRegistry({ config });
  const modelGateway = new ModelGateway(providerRegistry, config);
  const conversationStore = new ConversationStore();
  return { conversationStore, providerRegistry, modelGateway };
}

interface SmokeResult {
  tool: string;
  status: "pass" | "fail" | "timeout";
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  notes: string;
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<
  { ok: true; value: T } | { ok: false; error: string; timedOut: boolean }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`TIMEOUT after ${timeoutMs}ms`)),
        );
      }),
    ]);
    return { ok: true, value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = msg.startsWith("TIMEOUT");
    return { ok: false, error: msg, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function extractUsage(result: unknown): { input?: number; output?: number } {
  try {
    const r = result as {
      payload?: { usage?: { input_tokens?: number; output_tokens?: number } };
      metadata?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    const usage = r.payload?.usage ?? r.metadata?.usage;
    return { input: usage?.input_tokens, output: usage?.output_tokens };
  } catch {
    return {};
  }
}

async function smokeTool(
  name: string,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  notes: string,
): Promise<SmokeResult> {
  const start = Date.now();
  const exec = async () => tool.execute({ ...args });
  const res = await runWithTimeout(exec, TIMEOUT_MS);
  const latencyMs = Date.now() - start;
  if (res.ok) {
    const result = res.value as {
      ok: boolean;
      payload?: unknown;
      error?: { message?: string };
    };
    if (result.ok) {
      const usage = extractUsage(result);
      return {
        tool: name,
        status: "pass",
        latencyMs,
        inputTokens: usage.input,
        outputTokens: usage.output,
        notes,
      };
    }
    return {
      tool: name,
      status: "fail",
      latencyMs,
      error: result.error?.message ?? "unknown error (ok:false)",
      notes,
    };
  }
  return {
    tool: name,
    status: res.timedOut ? "timeout" : "fail",
    latencyMs,
    error: res.error,
    notes,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set");
    process.exit(1);
  }
  const config = buildConfig();
  const ctx = buildContext(config);
  const cwd = process.cwd();

  const workflowArgs = {
    step: "Investigate the entry point",
    findings: "Found src/index.ts as the main entry",
    step_number: 1,
    total_steps: 1,
    next_step_required: false,
    model: MODEL,
  };

  const tools: Array<{ name: string; run: () => Promise<SmokeResult> }> = [
    {
      name: "version",
      run: () =>
        smokeTool(
          "version",
          createVersionTool(),
          {},
          "static payload, no provider",
        ),
    },
    {
      name: "challenge",
      run: () =>
        smokeTool(
          "challenge",
          createChallengeTool(),
          { prompt: "The sky is blue." },
          "no provider call",
        ),
    },
    {
      name: "list_models",
      run: () =>
        smokeTool(
          "list_models",
          createListModelsTool(ctx.providerRegistry, config),
          {},
          "live discovery fetch",
        ),
    },
    {
      name: "chat",
      run: () =>
        smokeTool(
          "chat",
          createChatTool(ctx),
          {
            prompt: "Say hello in one word.",
            working_directory_absolute_path: cwd,
            model: MODEL,
          },
          "single provider call",
        ),
    },
    {
      name: "analyze",
      run: () =>
        smokeTool(
          "analyze",
          createAnalyzeTool(ctx),
          { ...workflowArgs },
          "workflow + expert",
        ),
    },
    {
      name: "debug",
      run: () =>
        smokeTool(
          "debug",
          createDebugTool(ctx),
          { ...workflowArgs },
          "workflow + expert",
        ),
    },
    {
      name: "tracer",
      run: () =>
        smokeTool(
          "tracer",
          createTracerTool(ctx),
          { ...workflowArgs, target_description: "src/index.ts" },
          "single-pass workflow",
        ),
    },
    {
      name: "secaudit",
      run: () =>
        smokeTool(
          "secaudit",
          createSecauditTool(ctx),
          { ...workflowArgs },
          "workflow + expert",
        ),
    },
    {
      name: "testgen",
      run: () =>
        smokeTool(
          "testgen",
          createTestgenTool(ctx),
          { ...workflowArgs },
          "workflow + expert",
        ),
    },
    {
      name: "docgen",
      run: () =>
        smokeTool(
          "docgen",
          createDocgenTool(ctx),
          {
            ...workflowArgs,
            num_files_documented: 0,
            total_files_to_document: 1,
          },
          "single-pass workflow",
        ),
    },
    {
      name: "refactor",
      run: () =>
        smokeTool(
          "refactor",
          createRefactorTool(ctx),
          { ...workflowArgs, refactor_type: "decompose" },
          "BROKEN: confidence enum excludes 'certain'",
        ),
    },
    {
      name: "codereview",
      run: () =>
        smokeTool(
          "codereview",
          createCodeReviewTool(ctx),
          { ...workflowArgs, review_type: "quick" },
          "workflow + expert",
        ),
    },
    {
      name: "precommit",
      run: () =>
        smokeTool(
          "precommit",
          createPrecommitTool(ctx),
          { ...workflowArgs, precommit_type: "internal", path: cwd },
          "BROKEN: never runs git",
        ),
    },
    {
      name: "planner",
      run: () =>
        smokeTool(
          "planner",
          createPlannerTool(ctx),
          {
            ...workflowArgs,
            findings: "Planning the migration from v1 to v2",
          },
          "single call, no expert",
        ),
    },
    {
      name: "thinkdeep",
      run: () =>
        smokeTool(
          "thinkdeep",
          createThinkDeepTool(ctx),
          { ...workflowArgs, thinking_mode: "low" },
          "workflow + expert, thinking low (not max to avoid huge latency)",
        ),
    },
    {
      name: "consensus",
      run: () =>
        smokeTool(
          "consensus",
          createConsensusTool(ctx),
          {
            step: "Test step",
            findings: "Test findings",
            step_number: 1,
            total_steps: 1,
            next_step_required: false,
            models: [{ model: MODEL }, { model: MODEL_2 }],
          },
          "2 models + synthesis, sequential",
        ),
    },
  ];

  const results: SmokeResult[] = [];
  for (const t of tools) {
    process.stderr.write(`\n>>> Testing ${t.name}...\n`);
    try {
      const r = await t.run();
      results.push(r);
      process.stderr.write(
        `    ${r.status} (${r.latencyMs}ms)${r.error ? ` err=${r.error.slice(0, 120)}` : ""}\n`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        tool: t.name,
        status: "fail",
        latencyMs: 0,
        error: `UNCAUGHT: ${msg}`,
        notes: "",
      });
      process.stderr.write(`    UNCAUGHT: ${msg.slice(0, 200)}\n`);
    }
  }

  console.log("\n## Phase 2 Live Smoke Test Results\n");
  console.log(
    `**Model:** ${MODEL} (free)  |  **Timeout:** ${TIMEOUT_MS}ms  |  **Date:** ${new Date().toISOString()}\n`,
  );
  console.log(
    "| Tool | Status | Latency (ms) | Input Tokens | Output Tokens | Error | Notes |",
  );
  console.log(
    "|------|--------|-------------|--------------|---------------|-------|-------|",
  );
  for (const r of results) {
    const err = r.error ? r.error.replace(/\|/g, "\\|").slice(0, 100) : "";
    console.log(
      `| ${r.tool} | ${r.status} | ${r.latencyMs} | ${r.inputTokens ?? "-"} | ${r.outputTokens ?? "-"} | ${err} | ${r.notes} |`,
    );
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const timedOut = results.filter((r) => r.status === "timeout").length;
  console.log(
    `\n**Summary:** ${passed} pass, ${failed} fail, ${timedOut} timeout (of ${results.length} tools)\n`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

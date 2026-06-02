import type { Stats } from "node:fs";
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod/v4";

import {
  type ConversationStore,
  type ConversationThread,
  MAX_THREAD_TURNS,
} from "../memory/conversations";
import type {
  GenerateTextResult,
  ProviderRegistry,
} from "../providers/registry";
import type { ModelInfo, Result, ToolError, ToolOutput } from "../types";
import { logger } from "../utils/logger";
import { estimateTokenCount } from "../utils/tokens";

const MAX_EMBEDDED_FILE_TOKENS = 50_000;
const MAX_HISTORY_TURNS = 8;

const ALLOWED_HOME_DIRS = [".claude", ".codex", ".copilot", ".opencode"];

function isAllowedPath(realPath: string): boolean {
  const cwd = realpathSync(process.cwd());
  if (realPath === cwd || realPath.startsWith(`${cwd}/`)) {
    return true;
  }

  const tmp = resolve(tmpdir());
  if (realPath === tmp || realPath.startsWith(`${tmp}/`)) {
    return true;
  }

  const home = homedir();
  for (const dir of ALLOWED_HOME_DIRS) {
    const allowed = resolve(home, dir);
    if (realPath === allowed || realPath.startsWith(`${allowed}/`)) {
      return true;
    }
  }

  return false;
}

export const ThinkingModeSchema = z
  .enum(["minimal", "low", "medium", "high", "max"])
  .optional();
export const ConfidenceSchema = z
  .enum([
    "exploring",
    "low",
    "medium",
    "high",
    "very_high",
    "almost_certain",
    "certain",
  ])
  .optional();
export const TemperatureSchema = z.number().min(0).max(1).optional();
export const ContinuationIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "ID from a previous tool response to continue that conversation thread. Omit to start new.",
  );
export const FilePathsSchema = z
  .preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string().min(1)).optional(),
  )
  .describe(
    "File paths (absolute or relative to cwd) to embed as context. May be skipped if outside allowed directories or exceeds token budget.",
  );
export const ImagesSchema = z.array(z.string().min(1)).optional();
export const IssuesFoundSchema = z
  .array(
    z
      .object({
        description: z.string().min(1),
        severity: z.enum(["critical", "high", "medium", "low"]),
      })
      .catchall(z.unknown()),
  )
  .optional();

export const BaseWorkflowInputSchema = z.object({
  confidence: ConfidenceSchema,
  continuation_id: ContinuationIdSchema,
  files_checked: z.array(z.string().min(1)).optional(),
  findings: z.string().min(1),
  images: ImagesSchema,
  issues_found: IssuesFoundSchema,
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model ID. Use an SDK model ID (e.g. 'gemini-2.5-pro', 'gpt-5.2', 'claude-sonnet-4-20250514') " +
        "or 'pluginId/modelName' for plugin models (e.g. 'copilot/claude-sonnet-4'). " +
        "Call list_models to see available options. Omit to auto-select the best available model.",
    ),
  next_step_required: z
    .boolean()
    .describe(
      "True if more steps are needed after this one. False on the final step.",
    ),
  relevant_context: z.array(z.string().min(1)).optional(),
  relevant_files: FilePathsSchema,
  step: z.string().min(1),
  step_number: z.number().int().min(1),
  temperature: TemperatureSchema,
  thinking_mode: ThinkingModeSchema,
  total_steps: z.number().int().min(1),
  use_assistant_model: z.boolean().optional(),
});

export interface ToolContext {
  conversationStore: ConversationStore;
  modelGateway: import("../providers/model-gateway").ModelGateway;
  providerRegistry: ProviderRegistry;
}

export interface EmbeddedFile {
  path: string;
  token_count: number;
}

export interface FileEmbeddingResult {
  embedded_files: EmbeddedFile[];
  embedded_text: string;
  skipped_files: Array<{ path: string; reason: string }>;
  total_tokens: number;
}

export interface PreparedConversation {
  continuationId: string;
  historyText: string;
  thread: ConversationThread;
}

export type ToolExecutionResult = Result<ToolOutput, ToolError>;

export function createToolError(
  type: ToolError["type"],
  message: string,
  details?: unknown,
): ToolError {
  return {
    details,
    message,
    retryable: false,
    type,
  };
}

export function createJsonToolOutput(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  continuationId?: string,
  remainingTurns?: number,
): ToolOutput {
  return {
    content: JSON.stringify(payload),
    content_type: "json",
    continuation_offer: continuationId
      ? {
          continuation_id: continuationId,
          note: "Reuse this continuation_id to continue the same tool thread.",
          remaining_turns: remainingTurns ?? Math.max(0, MAX_THREAD_TURNS - 1),
        }
      : undefined,
    metadata,
    status: "success",
  };
}

export function createSuccessToolResult(
  value: ToolOutput,
): ToolExecutionResult {
  return {
    ok: true,
    value,
  };
}

export async function selectModel(
  providerRegistry: ProviderRegistry,
  requestedModel?: string,
): Promise<ModelInfo> {
  if (requestedModel) {
    const exactModel = await providerRegistry.getModelInfo(requestedModel);

    if (
      exactModel &&
      providerRegistry.isProviderConfigured(exactModel.provider)
    ) {
      return exactModel;
    }

    logger.warn("Requested model not available, auto-selecting", {
      requested: requestedModel,
    });

    // Fall through to auto-select the best available model
  }

  const availableModels = (await providerRegistry.listModels()).sort(
    (left, right) => right.capabilities.score - left.capabilities.score,
  );

  if (availableModels.length === 0) {
    throw new Error("No configured AI models are available");
  }

  return availableModels[0];
}

export async function embedFiles(
  paths: string[] | undefined,
  modelInfo: ModelInfo,
): Promise<FileEmbeddingResult> {
  const uniquePaths = Array.from(new Set(paths ?? []));
  const embeddedFiles: EmbeddedFile[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  const sections: string[] = [];
  const maxTokens = Math.min(
    MAX_EMBEDDED_FILE_TOKENS,
    Math.max(4_000, Math.floor(modelInfo.capabilities.context_window * 0.4)),
  );
  let totalTokens = 0;

  for (const rawPath of uniquePaths) {
    const filePath = isAbsolute(rawPath)
      ? rawPath
      : resolve(process.cwd(), rawPath);

    let stats: Stats | undefined;
    let resolvedPath: string;

    try {
      resolvedPath = await realpath(filePath);
      stats = await stat(resolvedPath);
    } catch {
      skippedFiles.push({
        path: filePath,
        reason: "file_not_found",
      });
      continue;
    }

    if (!isAllowedPath(resolvedPath)) {
      skippedFiles.push({
        path: filePath,
        reason: "path_not_allowed",
      });
      continue;
    }

    if (!stats.isFile()) {
      skippedFiles.push({
        path: filePath,
        reason: "not_a_file",
      });
      continue;
    }

    const source = await Bun.file(resolvedPath).text();
    const tokenCount = estimateTokenCount(source);

    if (totalTokens + tokenCount > maxTokens) {
      skippedFiles.push({
        path: filePath,
        reason: "model_budget_exceeded",
      });
      continue;
    }

    embeddedFiles.push({
      path: filePath,
      token_count: tokenCount,
    });
    totalTokens += tokenCount;
    sections.push(`FILE: ${filePath}\n${source}`);
  }

  return {
    embedded_files: embeddedFiles,
    embedded_text: sections.join("\n\n"),
    skipped_files: skippedFiles,
    total_tokens: totalTokens,
  };
}

export async function prepareConversation(
  conversationStore: ConversationStore,
  continuationId?: string,
): Promise<PreparedConversation> {
  const existingThread = continuationId
    ? await conversationStore.resolveContinuation(continuationId)
    : undefined;
  const thread =
    existingThread ?? (await conversationStore.createThread(continuationId));
  const recentTurns = thread.turns.slice(-MAX_HISTORY_TURNS);
  const historyText = recentTurns
    .map((turn) => `[${turn.tool_name} @ ${turn.created_at}]\n${turn.content}`)
    .join("\n\n");

  return {
    continuationId: thread.id,
    historyText,
    thread,
  };
}

export async function recordConversationTurn(
  conversationStore: ConversationStore,
  continuationId: string,
  toolName: string,
  content: string,
): Promise<ConversationThread> {
  return conversationStore.addTurn(continuationId, {
    content,
    tool_name: toolName,
  });
}

export function toolFailureResult(
  type: ToolError["type"],
  message: string,
  details?: unknown,
): ToolExecutionResult {
  return {
    error: createToolError(type, message, details),
    ok: false,
  };
}

export function remainingConversationTurns(
  thread: ConversationThread | undefined,
): number | undefined {
  if (!thread) {
    return undefined;
  }

  return Math.max(0, MAX_THREAD_TURNS - thread.turns.length);
}

export function serializeUsage(
  usage: GenerateTextResult["usage"],
): Record<string, unknown> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

export function nextThreadId(): string {
  return crypto.randomUUID();
}

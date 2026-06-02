import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod/v4";

import { CHAT_SYSTEM_PROMPT } from "../../prompts/chat";
import type { ToolContext } from "../base";
import {
  ContinuationIdSchema,
  FilePathsSchema,
  ImagesSchema,
  TemperatureSchema,
  ThinkingModeSchema,
} from "../base";
import { createSimpleTool } from "../simple";

const ChatInputSchema = z.object({
  absolute_file_paths: FilePathsSchema,
  continuation_id: ContinuationIdSchema,
  images: ImagesSchema,
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model ID. Use an SDK model ID (e.g. 'gemini-2.5-pro', 'gpt-5.2', 'claude-sonnet-4-20250514') " +
        "or 'pluginId/modelName' for plugin models (e.g. 'copilot/claude-sonnet-4'). " +
        "Call list_models to see available options. Omit to auto-select the best available model.",
    ),
  prompt: z.string().min(1),
  temperature: TemperatureSchema,
  thinking_mode: ThinkingModeSchema,
  working_directory_absolute_path: z.string().min(1),
});

type ChatRequest = z.infer<typeof ChatInputSchema>;

async function assertWorkingDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error("working_directory_absolute_path must be an absolute path");
  }

  const workingDirectoryStats = await stat(path).catch(() => undefined);

  if (!workingDirectoryStats?.isDirectory()) {
    throw new Error(
      "working_directory_absolute_path must point to an existing directory",
    );
  }
}

function buildChatPrompt(
  historyText: string,
  request: ChatRequest,
  embeddedText: string,
): string {
  return [
    "General development request:",
    request.prompt,
    `Working directory: ${request.working_directory_absolute_path}`,
    request.thinking_mode
      ? `Requested thinking mode: ${request.thinking_mode}`
      : "",
    request.images && request.images.length > 0
      ? `Images:\n${request.images.join("\n")}`
      : "",
    historyText ? `Conversation history:\n${historyText}` : "",
    embeddedText ? `Embedded files:\n${embeddedText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createChatTool(context: ToolContext) {
  return createSimpleTool<typeof ChatInputSchema, ChatRequest>({
    buildPrompt: async ({ fileContext, historyText, request }) => {
      await assertWorkingDirectory(request.working_directory_absolute_path);

      return buildChatPrompt(historyText, request, fileContext.embedded_text);
    },
    context,
    description:
      "General chat and collaborative thinking partner for brainstorming, development discussion, getting second opinions, and exploring ideas. Use for ideas, validations, questions, and thoughtful explanations.",
    formatPayload: ({ aiResult, continuationId, fileContext, request }) => ({
      continuation_id: continuationId,
      embedded_files: fileContext.embedded_files,
      response: aiResult.text,
      skipped_files: fileContext.skipped_files,
      working_directory_absolute_path: request.working_directory_absolute_path,
    }),
    inputSchema: ChatInputSchema,
    name: "chat",
    systemPrompt: CHAT_SYSTEM_PROMPT,
  });
}

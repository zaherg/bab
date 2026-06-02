import type { z } from "zod/v4";

import type { GenerateTextResult, ThinkingMode } from "../providers/registry";
import type { RegisteredTool } from "../server";
import type { ToolOutput } from "../types";
import {
  createJsonToolOutput,
  createSuccessToolResult,
  createToolError,
  embedFiles,
  type FileEmbeddingResult,
  prepareConversation,
  recordConversationTurn,
  remainingConversationTurns,
  selectModel,
  serializeUsage,
  type ToolContext,
} from "./base";

export interface SimpleToolRequest {
  absolute_file_paths?: string[];
  continuation_id?: string;
  model?: string;
  temperature?: number;
  thinking_mode?: ThinkingMode;
}

export interface SimpleToolExecutionContext<
  TRequest extends SimpleToolRequest,
> {
  fileContext: FileEmbeddingResult;
  historyText: string;
  request: TRequest;
}

export interface SimpleToolResultContext<TRequest extends SimpleToolRequest> {
  aiResult: GenerateTextResult;
  continuationId: string;
  fileContext: FileEmbeddingResult;
  request: TRequest;
}

export interface SimpleToolConfig<
  TSchema extends z.ZodObject,
  TRequest extends SimpleToolRequest,
> {
  buildPrompt: (
    context: SimpleToolExecutionContext<TRequest>,
  ) => Promise<string> | string;
  context: ToolContext;
  description: string;
  formatPayload?: (
    context: SimpleToolResultContext<TRequest>,
  ) => Record<string, unknown>;
  inputSchema: TSchema;
  maxOutputTokens?: number;
  name: string;
  systemPrompt: string;
}

export function createSimpleTool<
  TSchema extends z.ZodObject,
  TRequest extends SimpleToolRequest,
>({
  buildPrompt,
  context,
  description,
  formatPayload,
  inputSchema,
  maxOutputTokens,
  name,
  systemPrompt,
}: SimpleToolConfig<TSchema, TRequest>): RegisteredTool {
  return {
    description,
    execute: async (rawArgs) => {
      try {
        const request = inputSchema.parse(rawArgs) as TRequest;
        const selectedModel = await selectModel(
          context.providerRegistry,
          request.model?.includes("/") ? undefined : request.model,
        );
        const delegateModelId = request.model?.includes("/")
          ? request.model
          : undefined;
        const conversation = await prepareConversation(
          context.conversationStore,
          request.continuation_id,
        );
        const fileContext = await embedFiles(
          request.absolute_file_paths,
          selectedModel,
        );
        const prompt = await buildPrompt({
          fileContext,
          historyText: conversation.historyText,
          request,
        });

        await recordConversationTurn(
          context.conversationStore,
          conversation.continuationId,
          name,
          `USER\n${prompt}`,
        );

        let aiResult: GenerateTextResult;
        if (delegateModelId) {
          aiResult = await context.modelGateway.query(
            delegateModelId,
            prompt,
            systemPrompt,
            {
              thinkingMode: request.thinking_mode,
              temperature: request.temperature,
              toolName: name,
            },
          );
        } else {
          const res = await context.providerRegistry.generateText(
            selectedModel.id,
            prompt,
            systemPrompt,
            {
              maxOutputTokens,
              thinkingMode: request.thinking_mode,
              temperature: request.temperature,
            },
          );
          if (!res.ok) throw new Error(res.error.message);
          aiResult = res.value;
        }

        await recordConversationTurn(
          context.conversationStore,
          conversation.continuationId,
          name,
          `ASSISTANT\n${aiResult.text}`,
        );

        const storedThread = await context.conversationStore.getThread(
          conversation.continuationId,
        );
        const payload = formatPayload?.({
          aiResult,
          continuationId: conversation.continuationId,
          fileContext,
          request,
        }) ?? {
          continuation_id: conversation.continuationId,
          embedded_files: fileContext.embedded_files,
          provider: aiResult.provider,
          response: aiResult.text,
          usage: serializeUsage(aiResult.usage),
        };
        const toolOutput: ToolOutput = createJsonToolOutput(
          payload,
          {
            continuation_id: conversation.continuationId,
            model: aiResult.model,
            provider: aiResult.provider,
            usage: serializeUsage(aiResult.usage),
          },
          conversation.continuationId,
          remainingConversationTurns(storedThread),
        );

        return createSuccessToolResult(toolOutput);
      } catch (error) {
        return {
          error: createToolError(
            "execution",
            error instanceof Error
              ? error.message
              : "Simple tool execution failed",
            error,
          ),
          ok: false,
        };
      }
    },
    inputSchema,
    name,
  };
}

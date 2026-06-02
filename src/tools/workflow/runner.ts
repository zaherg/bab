import type { z } from "zod/v4";

import type { GenerateTextResult } from "../../providers/registry";
import type { RegisteredTool } from "../../server";
import type { ToolOutput } from "../../types";
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
  type ToolExecutionResult,
} from "../base";

export interface WorkflowRequestLike {
  confidence?: string;
  continuation_id?: string;
  findings: string;
  model?: string;
  next_step_required: boolean;
  relevant_files?: string[];
  step: string;
  step_number: number;
  temperature?: number;
  thinking_mode?: string;
  total_steps: number;
  use_assistant_model?: boolean;
}

export interface WorkflowPromptContext<TRequest extends WorkflowRequestLike> {
  fileContext: FileEmbeddingResult;
  historyText: string;
  request: TRequest;
}

export interface WorkflowResult<TRequest extends WorkflowRequestLike> {
  aiResult: GenerateTextResult;
  continuationId: string;
  expertAnalysis?: GenerateTextResult;
  fileContext: FileEmbeddingResult;
  request: TRequest;
}

export interface WorkflowRunnerConfig<
  TSchema extends z.ZodObject,
  TRequest extends WorkflowRequestLike,
> {
  buildExpertPrompt?: (
    context: WorkflowPromptContext<TRequest> & { primaryResponse: string },
  ) => Promise<string> | string;
  buildPrompt: (
    context: WorkflowPromptContext<TRequest>,
  ) => Promise<string> | string;
  context: ToolContext;
  description: string;
  formatPayload: (result: WorkflowResult<TRequest>) => Record<string, unknown>;
  inputSchema: TSchema;
  maxOutputTokens?: number;
  name: string;
  systemPrompt: string;
}

export class WorkflowRunner<
  TSchema extends z.ZodObject,
  TRequest extends WorkflowRequestLike,
> {
  constructor(
    private readonly config: WorkflowRunnerConfig<TSchema, TRequest>,
  ) {}

  asTool(): RegisteredTool {
    return {
      description: this.config.description,
      execute: async (rawArgs) => this.execute(rawArgs),
      inputSchema: this.config.inputSchema,
      name: this.config.name,
    };
  }

  private async execute(
    rawArgs: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      const parsedRequest = this.config.inputSchema.parse(rawArgs) as TRequest;
      const selectedModel = await selectModel(
        this.config.context.providerRegistry,
        parsedRequest.model?.includes("/") ? undefined : parsedRequest.model,
      );
      const delegateModelId = parsedRequest.model?.includes("/")
        ? parsedRequest.model
        : undefined;
      const conversation = await prepareConversation(
        this.config.context.conversationStore,
        parsedRequest.continuation_id,
      );
      const fileContext = await embedFiles(
        parsedRequest.relevant_files,
        selectedModel,
      );
      const historyText = conversation.historyText;
      const prompt = await this.config.buildPrompt({
        fileContext,
        historyText,
        request: parsedRequest,
      });

      await recordConversationTurn(
        this.config.context.conversationStore,
        conversation.continuationId,
        this.config.name,
        `USER STEP ${parsedRequest.step_number}\n${prompt}`,
      );

      let aiResult: GenerateTextResult;
      if (delegateModelId) {
        aiResult = await this.config.context.modelGateway.query(
          delegateModelId,
          prompt,
          this.config.systemPrompt,
          {
            temperature: parsedRequest.temperature,
            toolName: this.config.name,
          },
        );
      } else {
        const res = await this.config.context.providerRegistry.generateText(
          selectedModel.id,
          prompt,
          this.config.systemPrompt,
          {
            maxOutputTokens: this.config.maxOutputTokens,
            temperature: parsedRequest.temperature,
          },
        );
        if (!res.ok) throw new Error(res.error.message);
        aiResult = res.value;
      }

      let expertAnalysis: GenerateTextResult | undefined;

      if (this.shouldRunExpertAnalysis(parsedRequest)) {
        const expertPrompt =
          (await this.config.buildExpertPrompt?.({
            fileContext,
            historyText,
            primaryResponse: aiResult.text,
            request: parsedRequest,
          })) ??
          [
            "Validate and strengthen the following workflow analysis.",
            aiResult.text,
          ].join("\n\n");

        if (delegateModelId) {
          expertAnalysis = await this.config.context.modelGateway.query(
            delegateModelId,
            expertPrompt,
            this.config.systemPrompt,
            {
              temperature: parsedRequest.temperature,
              toolName: this.config.name,
            },
          );
        } else {
          const res = await this.config.context.providerRegistry.generateText(
            selectedModel.id,
            expertPrompt,
            this.config.systemPrompt,
            {
              maxOutputTokens: this.config.maxOutputTokens,
              temperature: parsedRequest.temperature,
            },
          );
          if (!res.ok) throw new Error(res.error.message);
          expertAnalysis = res.value;
        }
      }

      const payload = this.config.formatPayload({
        aiResult,
        continuationId: conversation.continuationId,
        expertAnalysis,
        fileContext,
        request: parsedRequest,
      });
      const assistantRecord = JSON.stringify(payload);

      await recordConversationTurn(
        this.config.context.conversationStore,
        conversation.continuationId,
        this.config.name,
        `ASSISTANT STEP ${parsedRequest.step_number}\n${assistantRecord}`,
      );

      const storedThread =
        await this.config.context.conversationStore.getThread(
          conversation.continuationId,
        );
      const toolOutput: ToolOutput = createJsonToolOutput(
        payload,
        {
          continuation_id: conversation.continuationId,
          expert_analysis_ran: Boolean(expertAnalysis),
          model: aiResult.model,
          provider: aiResult.provider,
          step_number: parsedRequest.step_number,
          total_steps: parsedRequest.total_steps,
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
            : "Workflow tool execution failed",
          error,
        ),
        ok: false,
      };
    }
  }

  private shouldRunExpertAnalysis(request: TRequest): boolean {
    if (request.use_assistant_model === false) {
      return false;
    }

    return (
      request.confidence === "certain" || request.next_step_required === false
    );
  }
}

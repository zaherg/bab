import { z } from "zod/v4";

import { CONSENSUS_SYSTEM_PROMPT } from "../../prompts/consensus";
import type { GenerateTextResult } from "../../providers/registry";
import type { RegisteredTool } from "../../server";
import type { ToolOutput } from "../../types";
import {
  createJsonToolOutput,
  createSuccessToolResult,
  createToolError,
  embedFiles,
  prepareConversation,
  recordConversationTurn,
  remainingConversationTurns,
  selectModel,
  type ToolContext,
  type ToolExecutionResult,
  toolFailureResult,
} from "../base";

const ConsensusModelSchema = z.object({
  model: z
    .string()
    .min(1)
    .describe(
      "Model ID. Use an SDK model ID (e.g. 'gemini-2.5-pro', 'gpt-5.2') " +
        "or 'pluginId/modelName' for plugin models (e.g. 'copilot/claude-sonnet-4'). " +
        "Call list_models to see available options.",
    ),
  stance: z.enum(["for", "against", "neutral"]).optional(),
  stance_prompt: z.string().min(1).optional(),
  temperature: z.number().min(0).max(1).optional(),
  thinking_mode: z.enum(["minimal", "low", "medium", "high", "max"]).optional(),
});

const ConsensusResponseSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  response: z.string().min(1),
  stance: z.enum(["for", "against", "neutral"]),
});

const ConsensusInputSchema = z.object({
  continuation_id: z.string().min(1).optional(),
  current_model_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Index of next model to consult (0-based). Pass back from prior response to resume.",
    ),
  findings: z.string().min(1),
  images: z.array(z.string().min(1)).optional(),
  model_responses: z
    .array(ConsensusResponseSchema)
    .optional()
    .describe(
      "Responses from prior call. Pass back to resume an interrupted round.",
    ),
  models: z
    .array(ConsensusModelSchema)
    .min(2)
    .describe(
      "Models to consult (min 2). Each specifies a model ID and optional stance/temperature.",
    ),
  next_step_required: z.boolean(),
  parallel: z
    .boolean()
    .optional()
    .describe(
      "Consult all models concurrently. Default false (sequential, each sees prior responses).",
    ),
  relevant_files: z.array(z.string().min(1)).optional(),
  step: z.string().min(1),
  step_number: z.number().int().min(1),
  temperature: z.number().min(0).max(1).optional(),
  total_steps: z.number().int().min(1),
});

type ConsensusRequest = z.infer<typeof ConsensusInputSchema>;
type ConsensusModel = z.infer<typeof ConsensusModelSchema>;
type ConsensusResponse = z.infer<typeof ConsensusResponseSchema>;

function buildConsensusPrompt(
  request: ConsensusRequest,
  historyText: string,
  fileText: string,
  priorResponses: ConsensusResponse[],
  modelConfig: ConsensusModel,
): string {
  const stance = modelConfig.stance ?? "neutral";
  const priorResponseText =
    priorResponses.length > 0 ? JSON.stringify(priorResponses, null, 2) : "";

  return [
    `Consensus review for stance: ${stance}`,
    modelConfig.stance_prompt
      ? `Stance prompt:\n${modelConfig.stance_prompt}`
      : "",
    `Proposal:\n${request.step}`,
    `Current findings:\n${request.findings}`,
    historyText ? `Conversation history:\n${historyText}` : "",
    priorResponseText ? `Previous model responses:\n${priorResponseText}` : "",
    fileText ? `Embedded files:\n${fileText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildSynthesisPrompt(
  request: ConsensusRequest,
  historyText: string,
  modelResponses: ConsensusResponse[],
  fileText: string,
): string {
  return [
    "Synthesize the following model perspectives into a single recommendation.",
    `Proposal:\n${request.step}`,
    `Independent findings:\n${request.findings}`,
    historyText ? `Conversation history:\n${historyText}` : "",
    `Model responses:\n${JSON.stringify(modelResponses, null, 2)}`,
    fileText ? `Embedded files:\n${fileText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function aggregateUsage(
  results: GenerateTextResult[],
): Record<string, unknown> {
  return results.reduce(
    (carry, result) => ({
      input_tokens: carry.input_tokens + result.usage.input_tokens,
      output_tokens: carry.output_tokens + result.usage.output_tokens,
      total_tokens: carry.total_tokens + result.usage.total_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

export function createConsensusTool(context: ToolContext): RegisteredTool {
  return {
    description:
      "Builds multi-model consensus through systematic analysis and structured debate. " +
      "Each model entry accepts an SDK model ID (e.g. 'gpt-5.2', 'gemini-2.5-pro', 'claude-sonnet-4-20250514') " +
      "or a plugin model via 'pluginId/modelName' (e.g. 'copilot/claude-sonnet-4'). " +
      "Call list_models to see available SDK and plugin models. " +
      "Per-model temperature and thinking_mode (minimal/low/medium/high/max) can be set independently. " +
      "Set parallel:true to consult all models concurrently instead of step-by-step. " +
      "Use for complex decisions, architectural choices, feature proposals, and technology evaluations.",
    execute: async (rawArgs): Promise<ToolExecutionResult> => {
      try {
        const request = ConsensusInputSchema.parse(rawArgs);
        const synthesisModel = await selectModel(context.providerRegistry);
        const conversation = await prepareConversation(
          context.conversationStore,
          request.continuation_id,
        );
        const fileContext = await embedFiles(
          request.relevant_files,
          synthesisModel,
        );
        const startingModelIndex = request.current_model_index ?? 0;
        const previousResponses = [...(request.model_responses ?? [])];
        const consultedResults: GenerateTextResult[] = [];

        // In parallel mode, consult all remaining models at once.
        // In sequential mode, consult one model per call (step-by-step flow).
        const useParallel = request.parallel === true;
        const modelsToConsult = useParallel
          ? request.models.slice(startingModelIndex)
          : request.next_step_required
            ? request.models.slice(startingModelIndex, startingModelIndex + 1)
            : request.models.slice(startingModelIndex);

        await recordConversationTurn(
          context.conversationStore,
          conversation.continuationId,
          "consensus",
          `USER STEP ${request.step_number}\n${request.step}`,
        );

        let currentModelIndex = startingModelIndex;
        let latestResponse: ConsensusResponse | undefined;

        if (useParallel && modelsToConsult.length > 0) {
          // Parallel: use allSettled so a slow/failing model doesn't block the batch
          const settled = await Promise.allSettled(
            modelsToConsult.map((modelConfig) =>
              context.modelGateway.query(
                modelConfig.model,
                buildConsensusPrompt(
                  request,
                  conversation.historyText,
                  fileContext.embedded_text,
                  previousResponses,
                  modelConfig,
                ),
                CONSENSUS_SYSTEM_PROMPT,
                {
                  temperature: modelConfig.temperature ?? request.temperature,
                  thinkingMode: modelConfig.thinking_mode,
                  toolName: "consensus",
                },
              ),
            ),
          );

          // Collect results in input order
          for (let i = 0; i < settled.length; i++) {
            const modelConfig = modelsToConsult[i]!;
            const result = settled[i]!;

            if (result.status === "fulfilled") {
              consultedResults.push(result.value);
              latestResponse = {
                model: modelConfig.model,
                provider: result.value.provider,
                response: result.value.text,
                stance: modelConfig.stance ?? "neutral",
              };
            } else {
              // Failed model: record an error response so synthesis sees it
              latestResponse = {
                model: modelConfig.model,
                provider: "unknown",
                response: `[Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}]`,
                stance: modelConfig.stance ?? "neutral",
              };
            }

            previousResponses.push(latestResponse);
            currentModelIndex += 1;
          }
        } else {
          // Sequential: one model per step
          for (const modelConfig of modelsToConsult) {
            const result = await context.modelGateway.query(
              modelConfig.model,
              buildConsensusPrompt(
                request,
                conversation.historyText,
                fileContext.embedded_text,
                previousResponses,
                modelConfig,
              ),
              CONSENSUS_SYSTEM_PROMPT,
              {
                temperature: modelConfig.temperature ?? request.temperature,
                thinkingMode: modelConfig.thinking_mode,
                toolName: "consensus",
              },
            );

            consultedResults.push(result);
            latestResponse = {
              model: modelConfig.model,
              provider: result.provider,
              response: result.text,
              stance: modelConfig.stance ?? "neutral",
            };
            previousResponses.push(latestResponse);
            currentModelIndex += 1;
          }
        }

        let synthesis: GenerateTextResult | undefined;
        let responseText = latestResponse?.response ?? "";
        let nextStepRequired =
          !useParallel && currentModelIndex < request.models.length;

        if (!request.next_step_required || useParallel) {
          const synthResult = await context.providerRegistry.generateText(
            synthesisModel.id,
            buildSynthesisPrompt(
              request,
              conversation.historyText,
              previousResponses,
              fileContext.embedded_text,
            ),
            CONSENSUS_SYSTEM_PROMPT,
            {
              temperature: request.temperature,
            },
          );
          if (!synthResult.ok) {
            return {
              ok: false,
              error: createToolError("execution", synthResult.error.message),
            };
          }
          synthesis = synthResult.value;
          consultedResults.push(synthesis);
          responseText = synthesis.text;
          nextStepRequired = false;
        }

        const payload = {
          continuation_id: conversation.continuationId,
          current_model_index: currentModelIndex,
          model_responses: previousResponses,
          next_step_required: nextStepRequired,
          response: responseText,
          step_number: request.step_number,
          synthesis: synthesis?.text,
          total_steps: request.total_steps,
        };

        await recordConversationTurn(
          context.conversationStore,
          conversation.continuationId,
          "consensus",
          `ASSISTANT STEP ${request.step_number}\n${JSON.stringify(payload)}`,
        );

        const storedThread = await context.conversationStore.getThread(
          conversation.continuationId,
        );
        const toolOutput: ToolOutput = createJsonToolOutput(
          payload,
          {
            continuation_id: conversation.continuationId,
            consulted_models: previousResponses.map((entry) => entry.model),
            current_model_index: currentModelIndex,
            usage: aggregateUsage(consultedResults),
          },
          conversation.continuationId,
          remainingConversationTurns(storedThread),
        );

        return createSuccessToolResult(toolOutput);
      } catch (error) {
        return toolFailureResult(
          "execution",
          error instanceof Error
            ? error.message
            : "Consensus tool execution failed",
          error,
        );
      }
    },
    inputSchema: ConsensusInputSchema,
    name: "consensus",
  };
}

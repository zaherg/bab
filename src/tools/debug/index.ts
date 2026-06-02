import { z } from "zod/v4";

import { DEBUG_SYSTEM_PROMPT } from "../../prompts/debug";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const DebugInputSchema = BaseWorkflowInputSchema.extend({
  hypothesis: z.string().min(1).optional(),
});

type DebugRequest = z.infer<typeof DebugInputSchema> & WorkflowRequestLike;

function buildDebugPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<DebugRequest>): string {
  return [
    "Debug workflow step",
    `Step ${request.step_number} of ${request.total_steps}`,
    request.confidence ? `Confidence: ${request.confidence}` : "",
    request.hypothesis ? `Current hypothesis:\n${request.hypothesis}` : "",
    request.relevant_context?.length
      ? `Relevant context:\n${request.relevant_context.join("\n")}`
      : "",
    request.issues_found?.length
      ? `Known issues:\n${JSON.stringify(request.issues_found, null, 2)}`
      : "",
    `Investigation step:\n${request.step}`,
    `Findings so far:\n${request.findings}`,
    historyText ? `Conversation history:\n${historyText}` : "",
    fileContext.embedded_text
      ? `Embedded files:\n${fileContext.embedded_text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createDebugTool(context: ToolContext) {
  return new WorkflowRunner<typeof DebugInputSchema, DebugRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate this debugging analysis and challenge weak assumptions.",
        request.hypothesis ? `Hypothesis:\n${request.hypothesis}` : "",
        `Primary analysis:\n${primaryResponse}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    buildPrompt: buildDebugPrompt,
    context,
    description:
      "Performs systematic debugging and root cause analysis for any type of issue. Use for complex bugs, mysterious errors, performance issues, race conditions, memory leaks, and integration problems. Guides through structured investigation with hypothesis testing and expert analysis.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      confidence: request.confidence ?? "low",
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      files_checked: request.files_checked ?? [],
      hypothesis: request.hypothesis,
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: DebugInputSchema,
    name: "debug",
    systemPrompt: DEBUG_SYSTEM_PROMPT,
  }).asTool();
}

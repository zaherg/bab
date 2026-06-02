import { z } from "zod/v4";

import { THINKDEEP_SYSTEM_PROMPT } from "../../prompts/thinkdeep";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const ThinkDeepInputSchema = BaseWorkflowInputSchema.extend({
  focus_areas: z.array(z.string().min(1)).optional(),
  hypothesis: z.string().min(1).optional(),
  problem_context: z.string().min(1).optional(),
});

type ThinkDeepRequest = z.infer<typeof ThinkDeepInputSchema> &
  WorkflowRequestLike;

function buildThinkDeepPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<ThinkDeepRequest>): string {
  return [
    "ThinkDeep workflow step",
    `Step ${request.step_number} of ${request.total_steps}`,
    `Next step required: ${request.next_step_required}`,
    request.confidence ? `Confidence: ${request.confidence}` : "",
    request.problem_context
      ? `Problem context:\n${request.problem_context}`
      : "",
    request.focus_areas && request.focus_areas.length > 0
      ? `Focus areas: ${request.focus_areas.join(", ")}`
      : "",
    request.hypothesis ? `Current hypothesis:\n${request.hypothesis}` : "",
    request.relevant_context && request.relevant_context.length > 0
      ? `Relevant context:\n${request.relevant_context.join("\n")}`
      : "",
    request.issues_found && request.issues_found.length > 0
      ? `Issues found:\n${JSON.stringify(request.issues_found, null, 2)}`
      : "",
    `Current step:\n${request.step}`,
    `Findings so far:\n${request.findings}`,
    historyText ? `Conversation history:\n${historyText}` : "",
    fileContext.embedded_text
      ? `Embedded files:\n${fileContext.embedded_text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createThinkDeepTool(context: ToolContext) {
  return new WorkflowRunner<typeof ThinkDeepInputSchema, ThinkDeepRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate and strengthen this thinkdeep analysis.",
        request.problem_context
          ? `Problem context:\n${request.problem_context}`
          : "",
        request.hypothesis ? `Current hypothesis:\n${request.hypothesis}` : "",
        `Primary analysis:\n${primaryResponse}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    buildPrompt: buildThinkDeepPrompt,
    context,
    description:
      "Performs multi-stage investigation and reasoning for complex problem analysis. Use for architecture decisions, complex bugs, performance challenges, and security analysis. Provides systematic hypothesis testing, evidence-based investigation, and expert validation.",
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
      findings: request.findings,
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      relevant_context: request.relevant_context ?? [],
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      thinking_complete: request.next_step_required === false,
      total_steps: request.total_steps,
    }),
    inputSchema: ThinkDeepInputSchema,
    name: "thinkdeep",
    systemPrompt: THINKDEEP_SYSTEM_PROMPT,
  }).asTool();
}

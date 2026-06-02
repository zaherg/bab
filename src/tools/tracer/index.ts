import { z } from "zod/v4";

import { TRACER_SYSTEM_PROMPT } from "../../prompts/tracer";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const TracerInputSchema = BaseWorkflowInputSchema.extend({
  target_description: z.string().min(1),
  trace_mode: z.enum(["ask", "precision", "dependencies"]).default("ask"),
  use_assistant_model: z.boolean().default(false),
});

type TracerRequest = z.infer<typeof TracerInputSchema> & WorkflowRequestLike;

function buildTracerPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<TracerRequest>): string {
  return [
    "Tracer workflow step",
    `Trace mode: ${request.trace_mode}`,
    `Target:\n${request.target_description}`,
    request.relevant_context?.length
      ? `Relevant symbols:\n${request.relevant_context.join("\n")}`
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

export function createTracerTool(context: ToolContext) {
  return new WorkflowRunner<typeof TracerInputSchema, TracerRequest>({
    buildPrompt: buildTracerPrompt,
    context,
    description:
      "Performs systematic code tracing with modes for execution flow or dependency mapping. Use for method execution analysis, call chain tracing, dependency mapping, and architectural understanding. Supports precision mode (execution flow) and dependencies mode (structural relationships).",
    formatPayload: ({ aiResult, continuationId, fileContext, request }) => ({
      continuation_id: continuationId,
      current_mode: request.trace_mode,
      next_step_required: request.next_step_required,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      target_description: request.target_description,
      total_steps: request.total_steps,
      trace_complete: request.next_step_required === false,
    }),
    inputSchema: TracerInputSchema,
    name: "tracer",
    systemPrompt: TRACER_SYSTEM_PROMPT,
  }).asTool();
}

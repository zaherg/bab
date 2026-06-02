import { z } from "zod/v4";

import { CODEREVIEW_SYSTEM_PROMPT } from "../../prompts/codereview";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const CodeReviewInputSchema = BaseWorkflowInputSchema.extend({
  focus_on: z.string().min(1).optional(),
  review_type: z.enum(["full", "security", "performance", "quick"]).optional(),
  review_validation_type: z.enum(["external", "internal"]).optional(),
  severity_filter: z
    .enum(["critical", "high", "medium", "low", "all"])
    .optional(),
  standards: z.string().min(1).optional(),
});

type CodeReviewRequest = z.infer<typeof CodeReviewInputSchema> &
  WorkflowRequestLike;

function buildCodeReviewPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<CodeReviewRequest>): string {
  return [
    "Code review workflow step",
    `Step ${request.step_number} of ${request.total_steps}`,
    `Review type: ${request.review_type ?? "full"}`,
    `Validation mode: ${request.review_validation_type ?? "external"}`,
    request.focus_on ? `Focus on: ${request.focus_on}` : "",
    request.standards ? `Standards:\n${request.standards}` : "",
    request.severity_filter
      ? `Minimum severity to report: ${request.severity_filter}`
      : "",
    request.relevant_context && request.relevant_context.length > 0
      ? `Relevant context:\n${request.relevant_context.join("\n")}`
      : "",
    request.issues_found && request.issues_found.length > 0
      ? `Known issues so far:\n${JSON.stringify(request.issues_found, null, 2)}`
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

export function createCodeReviewTool(context: ToolContext) {
  return new WorkflowRunner<typeof CodeReviewInputSchema, CodeReviewRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate and strengthen this code review.",
        `Review type: ${request.review_type ?? "full"}`,
        request.focus_on ? `Focus area: ${request.focus_on}` : "",
        request.standards ? `Standards:\n${request.standards}` : "",
        `Primary review:\n${primaryResponse}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    buildPrompt: buildCodeReviewPrompt,
    context,
    description:
      "Performs systematic, step-by-step code review with expert validation. Use for comprehensive analysis covering quality, security, performance, and architecture. Guides through structured investigation to ensure thoroughness.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      files_checked: request.files_checked ?? [],
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      review_complete: request.next_step_required === false,
      review_type: request.review_type ?? "full",
      step_number: request.step_number,
      total_steps: request.total_steps,
      validation_type: request.review_validation_type ?? "external",
    }),
    inputSchema: CodeReviewInputSchema,
    name: "codereview",
    systemPrompt: CODEREVIEW_SYSTEM_PROMPT,
  }).asTool();
}

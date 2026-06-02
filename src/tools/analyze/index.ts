import { z } from "zod/v4";

import { ANALYZE_SYSTEM_PROMPT } from "../../prompts/analyze";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const AnalyzeInputSchema = BaseWorkflowInputSchema.extend({
  analysis_type: z
    .enum(["architecture", "performance", "security", "quality", "general"])
    .optional(),
  output_format: z.enum(["summary", "detailed", "actionable"]).optional(),
});

type AnalyzeRequest = z.infer<typeof AnalyzeInputSchema> & WorkflowRequestLike;

function buildAnalyzePrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<AnalyzeRequest>): string {
  return [
    "Analyze workflow step",
    `Step ${request.step_number} of ${request.total_steps}`,
    `Analysis type: ${request.analysis_type ?? "general"}`,
    `Output format: ${request.output_format ?? "detailed"}`,
    request.confidence ? `Confidence: ${request.confidence}` : "",
    request.relevant_context?.length
      ? `Relevant context:\n${request.relevant_context.join("\n")}`
      : "",
    request.issues_found?.length
      ? `Issues and concerns:\n${JSON.stringify(request.issues_found, null, 2)}`
      : "",
    `Current plan:\n${request.step}`,
    `Findings so far:\n${request.findings}`,
    historyText ? `Conversation history:\n${historyText}` : "",
    fileContext.embedded_text
      ? `Embedded files:\n${fileContext.embedded_text}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createAnalyzeTool(context: ToolContext) {
  return new WorkflowRunner<typeof AnalyzeInputSchema, AnalyzeRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate this code analysis and fill any important gaps.",
        `Analysis type: ${request.analysis_type ?? "general"}`,
        `Primary analysis:\n${primaryResponse}`,
      ].join("\n\n"),
    buildPrompt: buildAnalyzePrompt,
    context,
    description:
      "Performs comprehensive code analysis with systematic investigation and expert validation. Use for architecture, performance, maintainability, and pattern analysis. Guides through structured code review and strategic planning.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      analysis_type: request.analysis_type ?? "general",
      confidence: request.confidence ?? "low",
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      files_checked: request.files_checked ?? [],
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      output_format: request.output_format ?? "detailed",
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: AnalyzeInputSchema,
    name: "analyze",
    systemPrompt: ANALYZE_SYSTEM_PROMPT,
  }).asTool();
}

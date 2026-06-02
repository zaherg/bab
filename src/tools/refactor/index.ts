import { z } from "zod/v4";

import { REFACTOR_SYSTEM_PROMPT } from "../../prompts/refactor";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const RefactorIssueSchema = z
  .object({
    description: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    type: z.enum(["codesmells", "decompose", "modernize", "organization"]),
  })
  .catchall(z.unknown());

const RefactorInputSchema = BaseWorkflowInputSchema.omit({
  confidence: true,
  issues_found: true,
}).extend({
  confidence: z
    .enum(["exploring", "incomplete", "partial", "complete"])
    .optional(),
  focus_areas: z.array(z.string().min(1)).optional(),
  hypothesis: z.string().min(1).optional(),
  issues_found: z.array(RefactorIssueSchema).optional(),
  refactor_type: z
    .enum(["codesmells", "decompose", "modernize", "organization"])
    .optional(),
  style_guide_examples: z.array(z.string().min(1)).optional(),
});

type RefactorRequest = z.infer<typeof RefactorInputSchema> &
  WorkflowRequestLike;

function buildRefactorPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<RefactorRequest>): string {
  return [
    "Refactor workflow step",
    `Refactor type: ${request.refactor_type ?? "codesmells"}`,
    request.confidence ? `Confidence: ${request.confidence}` : "",
    request.focus_areas?.length
      ? `Focus areas: ${request.focus_areas.join(", ")}`
      : "",
    request.style_guide_examples?.length
      ? `Style guide examples:\n${request.style_guide_examples.join("\n")}`
      : "",
    request.issues_found?.length
      ? `Refactor opportunities:\n${JSON.stringify(request.issues_found, null, 2)}`
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

export function createRefactorTool(context: ToolContext) {
  return new WorkflowRunner<typeof RefactorInputSchema, RefactorRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate this refactoring analysis and improve the prioritization.",
        `Refactor type: ${request.refactor_type ?? "codesmells"}`,
        `Primary analysis:\n${primaryResponse}`,
      ].join("\n\n"),
    buildPrompt: buildRefactorPrompt,
    context,
    description:
      "Analyzes code for refactoring opportunities with systematic investigation. Use for code smell detection, decomposition planning, modernization, and maintainability improvements. Guides through structured analysis with expert validation.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      confidence: request.confidence ?? "incomplete",
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      focus_areas: request.focus_areas ?? [],
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      refactor_type: request.refactor_type ?? "codesmells",
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: RefactorInputSchema,
    name: "refactor",
    systemPrompt: REFACTOR_SYSTEM_PROMPT,
  }).asTool();
}

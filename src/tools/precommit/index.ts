import { z } from "zod/v4";

import { PRECOMMIT_SYSTEM_PROMPT } from "../../prompts/precommit";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const PrecommitInputSchema = BaseWorkflowInputSchema.extend({
  compare_to: z.string().min(1).optional(),
  focus_on: z.string().min(1).optional(),
  include_staged: z.boolean().optional(),
  include_unstaged: z.boolean().optional(),
  path: z.string().min(1).optional(),
  precommit_type: z.enum(["external", "internal"]).optional(),
  severity_filter: z
    .enum(["critical", "high", "medium", "low", "all"])
    .optional(),
});

type PrecommitRequest = z.infer<typeof PrecommitInputSchema> &
  WorkflowRequestLike;

function buildPrecommitPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<PrecommitRequest>): string {
  return [
    "Precommit workflow step",
    `Validation type: ${request.precommit_type ?? "external"}`,
    request.path ? `Repository path: ${request.path}` : "",
    request.compare_to ? `Compare against: ${request.compare_to}` : "",
    request.focus_on ? `Focus area: ${request.focus_on}` : "",
    request.include_staged !== undefined
      ? `Include staged: ${request.include_staged}`
      : "",
    request.include_unstaged !== undefined
      ? `Include unstaged: ${request.include_unstaged}`
      : "",
    request.issues_found?.length
      ? `Known issues:\n${JSON.stringify(request.issues_found, null, 2)}`
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

export function createPrecommitTool(context: ToolContext) {
  return new WorkflowRunner<typeof PrecommitInputSchema, PrecommitRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate this pre-commit review and highlight any release-blocking risks.",
        `Validation type: ${request.precommit_type ?? "external"}`,
        `Primary review:\n${primaryResponse}`,
      ].join("\n\n"),
    buildPrompt: buildPrecommitPrompt,
    context,
    description:
      "Validates git changes and repository state before committing with systematic analysis. Use for multi-repository validation, security review, change impact assessment, and completeness verification. Guides through structured investigation with expert analysis.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      compare_to: request.compare_to,
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      path: request.path,
      precommit_type: request.precommit_type ?? "external",
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: PrecommitInputSchema,
    name: "precommit",
    systemPrompt: PRECOMMIT_SYSTEM_PROMPT,
  }).asTool();
}

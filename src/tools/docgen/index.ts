import { z } from "zod/v4";

import { DOCGEN_SYSTEM_PROMPT } from "../../prompts/docgen";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const DocgenInputSchema = BaseWorkflowInputSchema.extend({
  comments_on_complex_logic: z.boolean().default(true),
  document_complexity: z.boolean().default(true),
  document_flow: z.boolean().default(true),
  num_files_documented: z.number().int().min(0),
  total_files_to_document: z.number().int().min(0),
  update_existing: z.boolean().default(true),
  use_assistant_model: z.boolean().default(false),
});

type DocgenRequest = z.infer<typeof DocgenInputSchema> & WorkflowRequestLike;

function buildDocgenPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<DocgenRequest>): string {
  return [
    "Documentation generation workflow step",
    `Files documented: ${request.num_files_documented}/${request.total_files_to_document}`,
    `Document complexity: ${request.document_complexity}`,
    `Document flow: ${request.document_flow}`,
    `Update existing docs: ${request.update_existing}`,
    `Inline comments on complex logic: ${request.comments_on_complex_logic}`,
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

export function createDocgenTool(context: ToolContext) {
  return new WorkflowRunner<typeof DocgenInputSchema, DocgenRequest>({
    buildPrompt: buildDocgenPrompt,
    context,
    description:
      "Generates comprehensive code documentation with systematic analysis of functions, classes, and complexity. Use for documentation generation, code analysis, complexity assessment, and API documentation. Analyzes code structure and patterns to create thorough documentation.",
    formatPayload: ({ aiResult, continuationId, fileContext, request }) => ({
      comments_on_complex_logic: request.comments_on_complex_logic,
      continuation_id: continuationId,
      document_complexity: request.document_complexity,
      document_flow: request.document_flow,
      next_step_required: request.next_step_required,
      num_files_documented: request.num_files_documented,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_files_to_document: request.total_files_to_document,
      total_steps: request.total_steps,
      update_existing: request.update_existing,
    }),
    inputSchema: DocgenInputSchema,
    name: "docgen",
    systemPrompt: DOCGEN_SYSTEM_PROMPT,
  }).asTool();
}

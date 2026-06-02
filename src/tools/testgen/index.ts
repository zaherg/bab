import { z } from "zod/v4";

import { TESTGEN_SYSTEM_PROMPT } from "../../prompts/testgen";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const TestgenInputSchema = BaseWorkflowInputSchema.omit({
  issues_found: true,
}).extend({
  issues_found: z.array(z.record(z.string(), z.unknown())).optional(),
});

type TestgenRequest = z.infer<typeof TestgenInputSchema> & WorkflowRequestLike;

function buildTestgenPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<TestgenRequest>): string {
  return [
    "Test generation workflow step",
    request.confidence ? `Confidence: ${request.confidence}` : "",
    request.relevant_context?.length
      ? `Functions and methods needing coverage:\n${request.relevant_context.join("\n")}`
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

export function createTestgenTool(context: ToolContext) {
  return new WorkflowRunner<typeof TestgenInputSchema, TestgenRequest>({
    buildExpertPrompt: ({ primaryResponse }) =>
      [
        "Validate this test plan and add any missing high-value scenarios.",
        `Primary test plan:\n${primaryResponse}`,
      ].join("\n\n"),
    buildPrompt: buildTestgenPrompt,
    context,
    description:
      "Creates comprehensive test suites with edge case coverage for specific functions, classes, or modules. Analyzes code paths, identifies failure modes, and generates framework-specific tests. Be specific about scope - target particular components rather than testing everything.",
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
      next_step_required: request.next_step_required,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: TestgenInputSchema,
    name: "testgen",
    systemPrompt: TESTGEN_SYSTEM_PROMPT,
  }).asTool();
}

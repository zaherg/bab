import { z } from "zod/v4";

import { PLANNER_SYSTEM_PROMPT } from "../../prompts/planner";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const PlannerInputSchema = BaseWorkflowInputSchema.extend({
  branch_from_step: z.number().int().min(1).optional(),
  findings: z.string().min(1).default(""),
  branch_id: z.string().min(1).optional(),
  is_branch_point: z.boolean().optional(),
  is_step_revision: z.boolean().optional(),
  more_steps_needed: z.boolean().optional(),
  revises_step_number: z.number().int().min(1).optional(),
  use_assistant_model: z.boolean().default(false),
});

type PlannerRequest = z.infer<typeof PlannerInputSchema> & WorkflowRequestLike;

function buildPlannerPrompt({
  historyText,
  request,
}: WorkflowPromptContext<PlannerRequest>): string {
  return [
    "Planner workflow step",
    `Step ${request.step_number} of ${request.total_steps}`,
    request.is_step_revision
      ? `This step revises step ${request.revises_step_number ?? "unknown"}`
      : "",
    request.is_branch_point
      ? `This step starts branch ${request.branch_id ?? "unnamed"} from step ${request.branch_from_step ?? "unknown"}`
      : "",
    request.more_steps_needed
      ? "More steps may be needed than previously planned."
      : "",
    `Current planning step:\n${request.step}`,
    request.findings ? `Planning findings so far:\n${request.findings}` : "",
    historyText ? `Conversation history:\n${historyText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createPlannerTool(context: ToolContext) {
  return new WorkflowRunner<typeof PlannerInputSchema, PlannerRequest>({
    buildPrompt: buildPlannerPrompt,
    context,
    description:
      "Breaks down complex tasks through interactive, sequential planning with revision and branching capabilities. Use for complex project planning, system design, migration strategies, and architectural decisions. Builds plans incrementally with deep reflection for complex scenarios.",
    formatPayload: ({ aiResult, continuationId, request }) => ({
      branch_from_step: request.branch_from_step,
      branch_id: request.branch_id,
      continuation_id: continuationId,
      is_branch_point: request.is_branch_point ?? false,
      is_step_revision: request.is_step_revision ?? false,
      more_steps_needed: request.more_steps_needed ?? false,
      next_step_required: request.next_step_required,
      response: aiResult.text,
      revises_step_number: request.revises_step_number,
      step_number: request.step_number,
      total_steps: request.total_steps,
    }),
    inputSchema: PlannerInputSchema,
    name: "planner",
    systemPrompt: PLANNER_SYSTEM_PROMPT,
  }).asTool();
}

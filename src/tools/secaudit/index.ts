import { z } from "zod/v4";

import { SECAUDIT_SYSTEM_PROMPT } from "../../prompts/secaudit";
import type { ToolContext } from "../base";
import { BaseWorkflowInputSchema } from "../base";
import {
  type WorkflowPromptContext,
  type WorkflowRequestLike,
  WorkflowRunner,
} from "../workflow/runner";

const SecauditInputSchema = BaseWorkflowInputSchema.extend({
  audit_focus: z
    .enum([
      "owasp",
      "compliance",
      "infrastructure",
      "dependencies",
      "comprehensive",
    ])
    .optional(),
  compliance_requirements: z.array(z.string().min(1)).optional(),
  security_scope: z.string().min(1).optional(),
  severity_filter: z
    .enum(["critical", "high", "medium", "low", "all"])
    .optional(),
  threat_level: z.enum(["low", "medium", "high", "critical"]).optional(),
});

type SecauditRequest = z.infer<typeof SecauditInputSchema> &
  WorkflowRequestLike;

function buildSecauditPrompt({
  fileContext,
  historyText,
  request,
}: WorkflowPromptContext<SecauditRequest>): string {
  return [
    "Security audit workflow step",
    `Audit focus: ${request.audit_focus ?? "comprehensive"}`,
    `Threat level: ${request.threat_level ?? "medium"}`,
    request.security_scope ? `Security scope:\n${request.security_scope}` : "",
    request.compliance_requirements?.length
      ? `Compliance requirements: ${request.compliance_requirements.join(", ")}`
      : "",
    request.relevant_context?.length
      ? `Security-critical context:\n${request.relevant_context.join("\n")}`
      : "",
    request.issues_found?.length
      ? `Known security issues:\n${JSON.stringify(request.issues_found, null, 2)}`
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

export function createSecauditTool(context: ToolContext) {
  return new WorkflowRunner<typeof SecauditInputSchema, SecauditRequest>({
    buildExpertPrompt: ({ primaryResponse, request }) =>
      [
        "Validate this security audit and identify any major blind spots.",
        `Audit focus: ${request.audit_focus ?? "comprehensive"}`,
        `Primary audit:\n${primaryResponse}`,
      ].join("\n\n"),
    buildPrompt: buildSecauditPrompt,
    context,
    description:
      "Performs comprehensive security audit with systematic vulnerability assessment. Use for OWASP Top 10 analysis, compliance evaluation, threat modeling, and security architecture review. Guides through structured security investigation with expert validation.",
    formatPayload: ({
      aiResult,
      continuationId,
      expertAnalysis,
      fileContext,
      request,
    }) => ({
      audit_focus: request.audit_focus ?? "comprehensive",
      compliance_requirements: request.compliance_requirements ?? [],
      continuation_id: continuationId,
      expert_analysis: expertAnalysis?.text,
      issues_found: request.issues_found ?? [],
      next_step_required: request.next_step_required,
      relevant_files: fileContext.embedded_files.map((file) => file.path),
      response: aiResult.text,
      step_number: request.step_number,
      threat_level: request.threat_level ?? "medium",
      total_steps: request.total_steps,
    }),
    inputSchema: SecauditInputSchema,
    name: "secaudit",
    systemPrompt: SECAUDIT_SYSTEM_PROMPT,
  }).asTool();
}

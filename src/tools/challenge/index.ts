import { z } from "zod/v4";

import { CHALLENGE_WRAP_PREFIX } from "../../prompts/challenge";
import type { RegisteredTool } from "../../server";
import type { ToolOutput } from "../../types";
import {
  createSuccessToolResult,
  createToolError,
  type ToolExecutionResult,
} from "../base";

const ChallengeInputSchema = z.object({
  prompt: z
    .string()
    .min(
      1,
      "Statement to scrutinize. If you invoke `challenge` manually, strip the word 'challenge' and pass just the statement.",
    ),
});

function wrapChallengePrompt(prompt: string): string {
  return [
    CHALLENGE_WRAP_PREFIX,
    `"${prompt}"`,
    "Respond with a direct analysis that explains where the statement is strong, weak, incomplete, or misleading.",
  ].join("\n\n");
}

export function createChallengeTool(): RegisteredTool {
  return {
    description:
      "Prevents reflexive agreement by forcing critical thinking and reasoned analysis when a statement is challenged. Trigger automatically when a user critically questions, disagrees or appears to push back on earlier answers, and use it manually to sanity-check contentious claims.",
    execute: async (rawArgs): Promise<ToolExecutionResult> => {
      try {
        const request = ChallengeInputSchema.parse(rawArgs);
        const payload = {
          challenge_prompt: wrapChallengePrompt(request.prompt),
          original_statement: request.prompt,
        };
        const output: ToolOutput = {
          content: JSON.stringify(payload),
          content_type: "json",
          metadata: {},
          status: "success",
        };

        return createSuccessToolResult(output);
      } catch (error) {
        return {
          error: createToolError(
            "execution",
            error instanceof Error
              ? error.message
              : "Challenge tool execution failed",
            error,
          ),
          ok: false,
        };
      }
    },
    inputSchema: ChallengeInputSchema,
    name: "challenge",
  };
}

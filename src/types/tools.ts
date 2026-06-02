import { z } from "zod/v4";

export const toolOutputStatusValues = [
  "success",
  "error",
  "files_required_to_continue",
  "full_codereview_required",
  "focused_review_required",
  "test_sample_needed",
  "more_tests_required",
  "refactor_analysis_complete",
  "trace_complete",
  "resend_prompt",
  "code_too_large",
  "continuation_available",
  "no_bug_found",
] as const;

export const toolContentTypeValues = ["text", "markdown", "json"] as const;

export const ToolOutputStatusSchema = z.enum(toolOutputStatusValues);
export const ToolContentTypeSchema = z.enum(toolContentTypeValues);

export const ContinuationOfferSchema = z.object({
  continuation_id: z.string().min(1, "continuation_id must not be empty"),
  note: z.string().min(1, "note must not be empty"),
  remaining_turns: z
    .number()
    .int()
    .min(0, "remaining_turns must be zero or greater"),
});

export const ToolOutputSchema = z.object({
  status: ToolOutputStatusSchema.default("success"),
  content: z.string().optional(),
  content_type: ToolContentTypeSchema.default("text"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  continuation_offer: ContinuationOfferSchema.optional(),
});

export const toolErrorTypeValues = [
  "validation",
  "configuration",
  "not_found",
  "execution",
  "timeout",
  "cancelled",
  "unknown",
] as const;

export const ToolErrorSchema = z.object({
  type: z.enum(toolErrorTypeValues),
  message: z.string().min(1, "message must not be empty"),
  details: z.unknown().optional(),
  retryable: z.boolean().default(false),
});

export type ContinuationOffer = z.infer<typeof ContinuationOfferSchema>;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
export type ToolError = z.infer<typeof ToolErrorSchema>;

export type SuccessResult<T> = {
  ok: true;
  value: T;
};

export type FailureResult<E> = {
  ok: false;
  error: E;
};

export type Result<T, E> = SuccessResult<T> | FailureResult<E>;

export function createSuccessResultSchema<ValueSchema extends z.ZodTypeAny>(
  valueSchema: ValueSchema,
) {
  return z.object({
    ok: z.literal(true),
    value: valueSchema,
  });
}

export function createFailureResultSchema<ErrorSchema extends z.ZodTypeAny>(
  errorSchema: ErrorSchema,
) {
  return z.object({
    ok: z.literal(false),
    error: errorSchema,
  });
}

export function createResultSchema<
  ValueSchema extends z.ZodTypeAny,
  ErrorSchema extends z.ZodTypeAny,
>(valueSchema: ValueSchema, errorSchema: ErrorSchema) {
  return z.discriminatedUnion("ok", [
    createSuccessResultSchema(valueSchema),
    createFailureResultSchema(errorSchema),
  ]);
}

export const ToolResultSchema = createResultSchema(
  ToolOutputSchema,
  ToolErrorSchema,
);

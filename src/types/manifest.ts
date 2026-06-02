import { z } from "zod/v4";

import { BuiltInRoleNameSchema, RoleDefinitionSchema } from "./roles";

const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const PluginCapabilitySchema = z.object({
  supports_cancellation: z.boolean().default(false),
  supports_images: z.boolean().default(false),
  supports_streaming: z.boolean().default(false),
  supports_working_directory: z.boolean().default(true),
  output_format: z.enum(["text", "json", "jsonl"]).default("text"),
});

export const PluginRoleSchema = z.union([
  BuiltInRoleNameSchema,
  RoleDefinitionSchema,
]);

export const PluginManifestSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/u,
      "id must contain only lowercase letters, numbers, underscores, and hyphens",
    ),
  name: z.string().min(1, "name must not be empty"),
  version: z
    .string()
    .regex(semverPattern, "version must be a valid semver string"),
  command: z.string().min(1, "command must not be empty"),
  roles: z
    .array(PluginRoleSchema)
    .min(1, "roles must include at least one role"),
  tool_prompts: z.record(z.string().min(1), z.string().min(1)).optional(),
  capabilities: PluginCapabilitySchema.default(() => ({
    supports_cancellation: false,
    supports_images: false,
    supports_streaming: false,
    supports_working_directory: true,
    output_format: "text" as const,
  })),
  delegate_api_version: z
    .number()
    .int()
    .positive("delegate_api_version must be a positive integer")
    .default(1),
});

export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;
export type PluginRole = z.infer<typeof PluginRoleSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

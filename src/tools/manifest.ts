import type { BabConfig } from "../config";
import type { ProviderRegistry } from "../providers/registry";
import type { RegisteredTool } from "../server";
import { createAnalyzeTool } from "./analyze";
import type { ToolContext } from "./base";
import { createChallengeTool } from "./challenge";
import { createChatTool } from "./chat";
import { createCodeReviewTool } from "./codereview";
import { createConsensusTool } from "./consensus";
import { createDebugTool } from "./debug";
import { createDelegateTool } from "./delegate";
import { createDocgenTool } from "./docgen";
import { createListModelsTool } from "./listmodels";
import { createPlannerTool } from "./planner";
import { createPrecommitTool } from "./precommit";
import { createRefactorTool } from "./refactor";
import { createSecauditTool } from "./secaudit";
import { createTestgenTool } from "./testgen";
import { createThinkDeepTool } from "./thinkdeep";
import { createTracerTool } from "./tracer";
import { createVersionTool } from "./version";

export type ToolCategory =
  | "analysis"
  | "delegation"
  | "generation"
  | "info"
  | "planning"
  | "review";

export type ToolPersistTier = "default" | "optional" | "never";

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: ToolCategory;
  persist: ToolPersistTier;
  factory: () => RegisteredTool;
}

// Tools always registered in lazy mode (in addition to the tools meta-tool)
export const ALWAYS_LOADED_TOOLS = new Set([
  "version",
  "delegate",
  "secaudit",
  "analyze",
]);

export function buildToolManifest(
  toolContext: ToolContext,
  providerRegistry: ProviderRegistry,
  config: BabConfig,
): Map<string, ToolManifestEntry> {
  const entries: ToolManifestEntry[] = [
    {
      name: "version",
      description: "Return the current Bab and runtime version information.",
      category: "info",
      persist: "never",
      factory: () => createVersionTool(),
    },
    {
      name: "delegate",
      description: "Run a prompt through a configured delegate CLI plugin.",
      category: "delegation",
      persist: "never",
      factory: () => createDelegateTool(config),
    },
    {
      name: "chat",
      description:
        "Direct model query with conversation threading. Use for focused Q&A, explanations, translations, and tasks that don't require multi-step workflows.",
      category: "delegation",
      persist: "optional",
      factory: () => createChatTool(toolContext),
    },
    {
      name: "analyze",
      description:
        "Performs comprehensive code analysis with systematic investigation and expert validation. Use for architecture, performance, maintainability, and pattern analysis.",
      category: "analysis",
      persist: "default",
      factory: () => createAnalyzeTool(toolContext),
    },
    {
      name: "debug",
      description:
        "Systematic debugging workflow with hypothesis formation and validation. Use for tracing bugs, understanding failures, and root cause analysis.",
      category: "analysis",
      persist: "default",
      factory: () => createDebugTool(toolContext),
    },
    {
      name: "tracer",
      description:
        "Trace code execution paths and data flows through a codebase. Use for understanding how data moves between components.",
      category: "analysis",
      persist: "default",
      factory: () => createTracerTool(toolContext),
    },
    {
      name: "secaudit",
      description:
        "Security audit workflow for identifying vulnerabilities, misconfigurations, and security risks in code.",
      category: "analysis",
      persist: "default",
      factory: () => createSecauditTool(toolContext),
    },
    {
      name: "testgen",
      description:
        "Generate comprehensive test suites with edge cases and integration tests for existing code.",
      category: "generation",
      persist: "optional",
      factory: () => createTestgenTool(toolContext),
    },
    {
      name: "docgen",
      description:
        "Generate technical documentation, API references, and code comments for a codebase.",
      category: "generation",
      persist: "optional",
      factory: () => createDocgenTool(toolContext),
    },
    {
      name: "refactor",
      description:
        "Systematic code refactoring with safety analysis. Use for improving code structure, reducing complexity, and applying design patterns.",
      category: "generation",
      persist: "default",
      factory: () => createRefactorTool(toolContext),
    },
    {
      name: "codereview",
      description:
        "Structured code review with multi-perspective analysis. Reviews for correctness, security, performance, and maintainability.",
      category: "review",
      persist: "default",
      factory: () => createCodeReviewTool(toolContext),
    },
    {
      name: "precommit",
      description:
        "Pre-commit review that checks staged changes for issues before committing. Validates correctness, tests, and code quality.",
      category: "review",
      persist: "optional",
      factory: () => createPrecommitTool(toolContext),
    },
    {
      name: "challenge",
      description:
        "Challenge assumptions and stress-test plans or decisions by generating critical counter-arguments.",
      category: "review",
      persist: "optional",
      factory: () => createChallengeTool(),
    },
    {
      name: "planner",
      description:
        "Break down complex tasks into structured, actionable implementation plans with dependency ordering.",
      category: "planning",
      persist: "default",
      factory: () => createPlannerTool(toolContext),
    },
    {
      name: "thinkdeep",
      description:
        "Extended multi-step reasoning for complex problems. Use for architectural decisions, trade-off analysis, and difficult design questions.",
      category: "planning",
      persist: "default",
      factory: () => createThinkDeepTool(toolContext),
    },
    {
      name: "consensus",
      description:
        "Builds multi-model consensus through systematic analysis and structured debate. " +
        "Call list_models first to see available SDK and plugin models. " +
        "Use for complex decisions, architectural choices, and technology evaluations.",
      category: "planning",
      persist: "default",
      factory: () => createConsensusTool(toolContext),
    },
    {
      name: "list_models",
      description:
        "List all available model IDs for use with other tools. " +
        "Shows SDK models and plugin models. Call before using model-dependent tools.",
      category: "info",
      persist: "never",
      factory: () => createListModelsTool(providerRegistry, config),
    },
  ];

  const manifest = new Map<string, ToolManifestEntry>();

  for (const entry of entries) {
    manifest.set(entry.name, entry);
  }

  return manifest;
}

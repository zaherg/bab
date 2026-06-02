import type {
  GetPromptResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";

type PromptType = "simple" | "workflow" | "multimodel" | "delegation";

interface PromptEntry {
  name: string;
  toolName: string;
  description: string;
  type: PromptType;
}

const PROMPT_REGISTRY: ReadonlyArray<PromptEntry> = [
  {
    name: "chat",
    toolName: "chat",
    description: "Chat and brainstorm ideas with an AI model.",
    type: "simple",
  },
  {
    name: "challenge",
    toolName: "challenge",
    description: "Challenge a claim or assumption with critical thinking.",
    type: "simple",
  },
  {
    name: "think",
    toolName: "thinkdeep",
    description: "Deep multi-stage reasoning for complex problems.",
    type: "workflow",
  },
  {
    name: "review",
    toolName: "codereview",
    description: "Systematic code review with expert validation.",
    type: "workflow",
  },
  {
    name: "debug",
    toolName: "debug",
    description: "Systematic debugging and root cause analysis.",
    type: "workflow",
  },
  {
    name: "analyze",
    toolName: "analyze",
    description: "Comprehensive code and architecture analysis.",
    type: "workflow",
  },
  {
    name: "refactor",
    toolName: "refactor",
    description: "Code refactoring opportunity analysis.",
    type: "workflow",
  },
  {
    name: "testgen",
    toolName: "testgen",
    description: "Generate comprehensive test suites with edge cases.",
    type: "workflow",
  },
  {
    name: "secaudit",
    toolName: "secaudit",
    description: "Security audit with vulnerability assessment.",
    type: "workflow",
  },
  {
    name: "docgen",
    toolName: "docgen",
    description: "Generate code documentation with complexity analysis.",
    type: "workflow",
  },
  {
    name: "tracer",
    toolName: "tracer",
    description: "Trace execution flow or map dependencies.",
    type: "workflow",
  },
  {
    name: "precommit",
    toolName: "precommit",
    description: "Validate changes before committing.",
    type: "workflow",
  },
  {
    name: "planner",
    toolName: "planner",
    description: "Interactive sequential planning with revision.",
    type: "workflow",
  },
  {
    name: "consensus",
    toolName: "consensus",
    description: "Multi-model consensus through structured debate.",
    type: "multimodel",
  },
  {
    name: "delegate",
    toolName: "delegate",
    description: "Delegate a task to a CLI agent (Codex, Copilot, OpenCode).",
    type: "delegation",
  },
] as const;

function buildPromptText(entry: PromptEntry, userInput: string): string {
  const input = userInput.trim();

  switch (entry.type) {
    case "simple":
      return input
        ? `Call the \`${entry.toolName}\` tool with prompt: ${input}`
        : `Call the \`${entry.toolName}\` tool. Ask the user what they'd like to discuss.`;

    case "workflow":
      return [
        `Call the \`${entry.toolName}\` tool to perform: ${entry.description}`,
        "",
        input
          ? `Context from the user: ${input}`
          : "Ask the user for context about what to analyze.",
        "",
        "Set step_number: 1, total_steps: 3 (adjust based on scope), next_step_required: true.",
        "Use a descriptive step name. If the user mentions files, include them in relevant_files.",
        "Continue calling the tool with increasing step_number until the response indicates completion.",
        "Summarize findings at the end.",
      ].join("\n");

    case "multimodel":
      return [
        `Call the \`${entry.toolName}\` tool for multi-model consensus.`,
        "",
        input
          ? `Topic: ${input}`
          : "Ask the user what topic needs multi-model consensus.",
        "",
        "Set step_number: 1, total_steps: 3, next_step_required: true.",
        "If the user requests specific models, include them. Otherwise let bab auto-select.",
        "Continue until consensus is reached.",
      ].join("\n");

    case "delegation":
      return [
        `Call the \`${entry.toolName}\` tool to delegate a task to an external CLI agent.`,
        "",
        input
          ? `Task: ${input}`
          : "Ask the user what task to delegate and to which agent.",
        "",
        "If the user names an agent (codex, copilot, opencode, claude), pass it as cli_name.",
        'Use role: "default" unless the user specifies otherwise.',
      ].join("\n");
  }
}

export function listPrompts(): Prompt[] {
  return PROMPT_REGISTRY.map((entry) => ({
    name: entry.name,
    description: entry.description,
    arguments: [
      {
        name: "args",
        description: "Your input or question",
        required: false,
      },
    ],
  }));
}

export function getPrompt(
  name: string,
  args: Record<string, string> | undefined,
): GetPromptResult {
  const entry = PROMPT_REGISTRY.find((p) => p.name === name);

  if (!entry) {
    throw new Error(`Unknown prompt: ${name}`);
  }

  const userInput = args?.args ?? "";
  const text = buildPromptText(entry, userInput);

  return {
    description: entry.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text,
        },
      },
    ],
  };
}

export const PROMPT_NAMES = PROMPT_REGISTRY.map((p) => p.name);

import { spawnSync } from "node:child_process";

const PROVIDER_ID = "opencode";
const COMMAND = "opencode";

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function processEnvRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function hasAnyKnownAuthEnv(
  env: Record<string, string> = processEnvRecord(),
): boolean {
  return [
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMI_API_KEY",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
  ].some((name) => normalizeText(env[name]));
}

function resolveModel(
  role: {
    args?: Record<string, string | number | boolean>;
    name: string;
  },
  env: Record<string, string> = processEnvRecord(),
): string | undefined {
  const envModel =
    normalizeText(env.BAB_OPENCODE_MODEL) ?? normalizeText(env.OPENCODE_MODEL);

  if (envModel) {
    return envModel;
  }

  const roleModel = normalizeText(role.args?.model);

  if (roleModel) {
    return roleModel;
  }

  if (normalizeText(env.DEEPSEEK_API_KEY)) {
    return "deepseek/deepseek-chat";
  }

  if (normalizeText(env.KIMI_API_KEY)) {
    return "kimi-for-coding/k2p5";
  }

  if (normalizeText(env.GITHUB_TOKEN)) {
    return "github-copilot/gpt-5.2";
  }

  return undefined;
}

function extractErrorMessage(
  event: Record<string, unknown>,
): string | undefined {
  const directMessage = normalizeText(event.message);

  if (directMessage) {
    return directMessage;
  }

  const error = event.error;

  if (error && typeof error === "object" && !Array.isArray(error)) {
    const typedError = error as Record<string, unknown>;
    const data = typedError.data;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const dataMessage = normalizeText(
        (data as Record<string, unknown>).message,
      );

      if (dataMessage) {
        return dataMessage;
      }
    }

    return normalizeText(typedError.message);
  }

  return undefined;
}

export function parseOpenCodeJsonOutput(
  stdout: string,
  stderr = "",
): { content: string; metadata: Record<string, unknown> } {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const messages: string[] = [];
  const errors: string[] = [];
  const metadata: Record<string, unknown> = {};

  for (const line of lines) {
    if (!line.startsWith("{")) {
      continue;
    }

    let parsedLine: unknown;

    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      !parsedLine ||
      typeof parsedLine !== "object" ||
      Array.isArray(parsedLine)
    ) {
      continue;
    }

    const event = parsedLine as Record<string, unknown>;
    const sessionId =
      normalizeText(event.sessionID) ?? normalizeText(event.sessionId);

    if (sessionId) {
      metadata.session_id = sessionId;
    }

    const eventType = normalizeText(event.type);

    if (eventType === "text") {
      const part = event.part;

      if (part && typeof part === "object" && !Array.isArray(part)) {
        const text = normalizeText((part as Record<string, unknown>).text);

        if (text) {
          messages.push(text);
        }
      }
    } else if (eventType === "assistant.message") {
      const data = event.data;

      if (data && typeof data === "object" && !Array.isArray(data)) {
        const text = normalizeText((data as Record<string, unknown>).content);

        if (text) {
          messages.push(text);
        }
      }
    } else if (eventType === "step_finish") {
      const part = event.part;

      if (part && typeof part === "object" && !Array.isArray(part)) {
        const typedPart = part as Record<string, unknown>;
        const tokens = typedPart.tokens;

        if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
          metadata.tokens = tokens as Record<string, unknown>;
        }

        if (typeof typedPart.cost === "number") {
          metadata.cost = typedPart.cost;
        }

        const reason = normalizeText(typedPart.reason);

        if (reason) {
          metadata.reason = reason;
        }
      }
    } else if (eventType === "result") {
      const usage = event.usage;

      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        metadata.usage = usage as Record<string, unknown>;
      }
    } else if (eventType === "error") {
      const message = extractErrorMessage(event);

      if (message) {
        errors.push(message);
      }
    }
  }

  if (messages.length === 0 && errors.length > 0) {
    messages.push(...errors);
    metadata.errors = errors;
  }

  if (stderr.trim()) {
    metadata.stderr = stderr.trim();
  }

  if (messages.length === 0) {
    throw new Error(
      "OpenCode JSON output did not include a text-bearing event",
    );
  }

  return {
    content: messages.join("\n\n"),
    metadata,
  };
}

const adapter = {
  buildCommand(input: {
    env?: Record<string, string>;
    prompt: string;
    role: {
      args: Record<string, string | number | boolean>;
      name: string;
      prompt: string;
    };
  }) {
    const rolePrompt = input.role.prompt.trim();
    const fullPrompt = rolePrompt
      ? `${rolePrompt}\n\n${input.prompt}`
      : input.prompt;
    const args = ["run", fullPrompt, "--format", "json"];
    const commandEnv = input.env ?? {};
    const model = resolveModel(input.role, commandEnv);

    if (model) {
      args.push("--model", model);
    }

    for (const [name, value] of Object.entries(input.role.args ?? {})) {
      if (name === "model") {
        continue;
      }

      const flag = `--${name.replaceAll("_", "-")}`;

      if (typeof value === "boolean") {
        if (value) {
          args.push(flag);
        }
        continue;
      }

      args.push(flag, String(value));
    }

    if (model) {
      const modelsCheck = spawnSync(COMMAND, ["models"], {
        env: commandEnv,
        encoding: "utf8",
      });

      if (modelsCheck.status === 0) {
        const available = modelsCheck.stdout
          .split("\n")
          .map((m) => m.trim())
          .filter(Boolean);

        if (!available.includes(model)) {
          throw new Error(
            `Model "${model}" is not available in OpenCode. Available: ${available
              .slice(0, 5)
              .join(", ")}...`,
          );
        }
      }
    }

    return { args, env: commandEnv };
  },
  discover() {
    return {
      command: COMMAND,
      id: PROVIDER_ID,
      name: "OpenCode CLI",
      output_format: "jsonl",
      roles: ["default", "planner", "codereviewer", "researcher"],
    };
  },
  listModels(): string[] {
    const result = spawnSync(COMMAND, ["models"], {
      env: process.env,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((m) => m.trim())
      .filter(Boolean);
  },
  parseResult(result: { stderr: string; stdout: string }) {
    const parsed = parseOpenCodeJsonOutput(result.stdout, result.stderr);
    delete parsed.metadata.events;
    return parsed;
  },
  validate() {
    if (!Bun.which(COMMAND)) {
      throw new Error("OpenCode CLI binary `opencode` was not found on PATH");
    }

    const auth = spawnSync(COMMAND, ["auth", "list"], {
      env: process.env,
      encoding: "utf8",
    });

    if (auth.status !== 0) {
      throw new Error("OpenCode auth inspection failed");
    }

    const output = `${auth.stdout}\n${auth.stderr}`;

    if (!/●\s+/u.test(output) && !hasAnyKnownAuthEnv()) {
      throw new Error(
        "OpenCode has no configured credentials or environment-backed providers",
      );
    }
  },
};

export default adapter;

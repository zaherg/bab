import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

import { currentProcessEnv, sanitizeFileEnv } from "./utils/env";

const CONFIG_ROOT_DIR = ".config";
const CONFIG_DIR_NAME = "bab";

export interface BabConfigPaths {
  baseDir: string;
  envFile: string;
  pluginsDir: string;
  promptsDir: string;
}

export interface BabPersistenceConfig {
  enabled: boolean;
  enabledTools: Set<string>;
  disabledTools: Set<string>;
}

export interface BabConfig {
  env: Record<string, string>;
  lazyTools?: boolean;
  paths: BabConfigPaths;
  persistence?: BabPersistenceConfig;
}

export interface ParseEnvFileOptions {
  source?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas (#7, #16)
// ---------------------------------------------------------------------------

const BoolEnv = z.string().transform((v) => v === "1" || v.toLowerCase() === "true");

const CommaSeparatedList = z.string().transform((v) =>
  v.split(",").map((s) => s.trim()).filter(Boolean),
);

const PositiveInt = z.string().regex(/^\d+$/u, "must be a positive integer").transform(Number);

export const BabEnvSchema = z.object({
  BAB_EAGER_TOOLS: BoolEnv.optional(),
  BAB_PERSIST: BoolEnv.optional(),
  BAB_PERSIST_TOOLS: CommaSeparatedList.optional(),
  BAB_DISABLED_PERSIST_TOOLS: CommaSeparatedList.optional(),
  BAB_DISABLED_TOOLS: CommaSeparatedList.optional(),
  BAB_ENABLED_TOOLS: CommaSeparatedList.optional(),
  BAB_CLI_TIMEOUT_MS: PositiveInt.optional(),
  BAB_MAX_CONCURRENT_PROCESSES: PositiveInt.optional(),
}).passthrough();

/** Validate known BAB_* env vars via Zod. Returns parsed result or throws with clear messages. */
function validateBabEnv(env: Record<string, string>): z.infer<typeof BabEnvSchema> {
  const result = BabEnvSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid BAB environment config:\n  ${messages.join("\n  ")}`);
  }
  return result.data;
}

const EnvKeySchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u, "invalid environment variable name");

export function getConfigPaths(homeDirectory = homedir()): BabConfigPaths {
  const baseDir = join(homeDirectory, CONFIG_ROOT_DIR, CONFIG_DIR_NAME);

  return {
    baseDir,
    envFile: join(baseDir, "env"),
    pluginsDir: join(baseDir, "plugins"),
    promptsDir: join(baseDir, "prompts"),
  };
}

function normalizeEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    throw new Error(`mismatched quotes in value: ${trimmed}`);
  }

  return trimmed;
}

export function parseEnvFile(
  contents: string,
  options: ParseEnvFileOptions = {},
): Record<string, string> {
  const parsed: Record<string, string> = {};
  const source = options.source ?? "env";
  const lines = contents.split(/\r?\n/u);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separatorIndex = normalizedLine.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error(
        `${source}: line ${index + 1}: expected KEY=VALUE assignment`,
      );
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = normalizedLine.slice(separatorIndex + 1);

    const keyResult = EnvKeySchema.safeParse(key);
    if (!keyResult.success) {
      throw new Error(
        `${source}: line ${index + 1}: invalid environment variable name "${key}"`,
      );
    }

    try {
      parsed[key] = normalizeEnvValue(value);
    } catch (error) {
      throw new Error(
        `${source}: line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return parsed;
}

export async function ensureConfigDirectories(
  paths = getConfigPaths(),
): Promise<BabConfigPaths> {
  await mkdir(paths.baseDir, { recursive: true });
  await Promise.all([
    mkdir(paths.pluginsDir, { recursive: true }),
    mkdir(paths.promptsDir, { recursive: true }),
  ]);

  return paths;
}

async function readConfigEnvFile(
  envFile: string,
): Promise<Record<string, string>> {
  try {
    const contents = await Bun.file(envFile).text();
    return parseEnvFile(contents, { source: envFile });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function loadConfig(homeDirectory?: string): Promise<BabConfig> {
  const paths = await ensureConfigDirectories(getConfigPaths(homeDirectory));
  const fileEnv = await readConfigEnvFile(paths.envFile);
  const processEnv = currentProcessEnv();

  const env = {
    ...sanitizeFileEnv(fileEnv),
    ...processEnv,
  };

  // Validate known BAB_* keys via Zod schema (#7)
  const validated = validateBabEnv(env);

  const persistEnabled = validated.BAB_PERSIST !== false;
  const enabledTools = new Set(validated.BAB_PERSIST_TOOLS ?? []);
  const disabledTools = new Set(validated.BAB_DISABLED_PERSIST_TOOLS ?? []);

  // #6: Lazy loading ON by default; BAB_EAGER_TOOLS=1 opts out
  const eagerTools = validated.BAB_EAGER_TOOLS === true;

  return {
    env,
    lazyTools: !eagerTools,
    paths,
    persistence: {
      enabled: persistEnabled,
      enabledTools,
      disabledTools,
    },
  };
}

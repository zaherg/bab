import { join } from "node:path";
import { parseEnvFile } from "../config";
import { assertPathContainment } from "../utils/path";

/** Vars that can inject code into spawned processes. */
const RUNTIME_INJECTION_VARS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
] as const;

const FILE_ENV_DENYLIST = new Set([
  ...RUNTIME_INJECTION_VARS,
  "HOME",
  "PWD",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

/** Env var prefixes stripped from the merged env before passing to delegates. */
const PROCESS_ENV_STRIP_PREFIXES = ["CLAUDE_", "CLAUDECODE", "BAB_"];

export const SECRET_SUFFIXES = [
  "_API_KEY",
  "_PASSWORD",
  "_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_ACCESS_KEY_ID",
  "_SECRET_ACCESS_KEY",
  "_SESSION_TOKEN",
] as const;

const DELEGATE_ENV_STRIP_PATTERNS: Array<(key: string) => boolean> =
  SECRET_SUFFIXES.map((suffix) => (key: string) => key.endsWith(suffix));

/**
 * Dangerous env vars stripped from process env before passing to delegates.
 * API keys are stripped here; plugins that need a specific key must declare it
 * in their manifest env file so it gets injected explicitly.
 */
const DELEGATE_ENV_DENYLIST: Set<string> = new Set([
  ...RUNTIME_INJECTION_VARS,
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

function isFileEnvDenied(key: string): boolean {
  return FILE_ENV_DENYLIST.has(key) || key.startsWith("BAB_");
}

function isDelegateSecretEnv(key: string): boolean {
  return (
    PROCESS_ENV_STRIP_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    DELEGATE_ENV_DENYLIST.has(key) ||
    DELEGATE_ENV_STRIP_PATTERNS.some((pattern) => pattern(key))
  );
}

export function currentProcessEnv(
  processEnv:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(processEnv).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

export function sanitizeFileEnv(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !isFileEnvDenied(key)),
  );
}

function sanitizeGlobalDelegateEnv(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !isFileEnvDenied(key) && !isDelegateSecretEnv(key),
    ),
  );
}

export async function readPluginEnv(
  directory: string,
): Promise<Record<string, string>> {
  const envPath = join(directory, "env");

  try {
    const realEnvPath = await assertPathContainment(envPath, directory, "env");
    const contents = await Bun.file(realEnvPath).text();
    return parseEnvFile(contents, { source: envPath });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export function mergeEnv(
  processEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  globalEnv: Record<string, string>,
  pluginEnv: Record<string, string>,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(currentProcessEnv(processEnv)).filter(
      ([key]) => !isDelegateSecretEnv(key),
    ),
  );

  return {
    ...base,
    ...sanitizeGlobalDelegateEnv(globalEnv),
    ...sanitizeFileEnv(pluginEnv),
  };
}

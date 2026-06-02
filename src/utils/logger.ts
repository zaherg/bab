import { mkdirSync } from "node:fs";
import { createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  configure,
  getJsonLinesFormatter,
  getLogger,
  getStreamSink,
  type LogLevel as LogTapeLevel,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface WrappedLogger {
  debug(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
}

const LOGTAPE_LEVELS: Record<LogLevel, LogTapeLevel> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

const LOGS_DIR = join(homedir(), ".config", "bab", "logs");
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 3;

function resolveLevel(): LogTapeLevel {
  const raw = process.env.BAB_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LOGTAPE_LEVELS) {
    return LOGTAPE_LEVELS[raw as LogLevel];
  }
  return "info";
}

function wrap(category: string[]): WrappedLogger {
  const lt = getLogger(category);
  return {
    debug: (msg, ctx) => (ctx ? lt.with(ctx) : lt).debug(msg),
    error: (msg, ctx) => (ctx ? lt.with(ctx) : lt).error(msg),
    info: (msg, ctx) => (ctx ? lt.with(ctx) : lt).info(msg),
    warn: (msg, ctx) => (ctx ? lt.with(ctx) : lt).warn(msg),
  };
}

const SECRET_REDACTION_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
}> = [
  { pattern: /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/g, replacement: "$1-[REDACTED]" },
  {
    pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/g,
    replacement: "sk-ant-[REDACTED]",
  },
  {
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g,
    replacement: "$1_[REDACTED]",
  },
  {
    pattern: /\b(xox[abpsr]?)-[a-zA-Z0-9-]{20,}\b/g,
    replacement: "$1-[REDACTED]",
  },
  {
    pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
    replacement: "Bearer [REDACTED]",
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
];

export function redactSecrets(text: string): string {
  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * A sink that routes client logs to per-plugin files based on the
 * third element of the log category: ["bab", "client", pluginId].
 * Secrets are redacted from the log output before writing.
 */
function createPerClientFileSink(): Sink & Disposable {
  const formatter = getJsonLinesFormatter();
  const streams = new Map<string, WriteStream>();

  const sink = (record: LogRecord) => {
    const pluginId = record.category[2];
    if (!pluginId) return;

    let stream = streams.get(pluginId);
    if (!stream) {
      stream = createWriteStream(join(LOGS_DIR, `${pluginId}.log`), {
        flags: "a",
      });
      streams.set(pluginId, stream);
    }

    stream.write(redactSecrets(formatter(record)));
  };

  const dispose = (): void => {
    for (const stream of streams.values()) {
      stream.end();
    }
    streams.clear();
  };

  return Object.assign(sink, { [Symbol.dispose]: dispose });
}

/**
 * Initialise LogTape. Call once at startup before any logging.
 *
 * Log files in ~/.config/bab/logs/:
 *   - mcp.log — server lifecycle, tool calls, protocol events (all levels)
 *   - error.log — errors and warnings only, for quick debugging
 *   - <pluginId>.log — per-plugin delegate I/O (opencode.log, copilot.log, etc.)
 *
 * All logs also go to stderr as JSON lines.
 * Set BAB_CLIENT_LOG=false to disable client file logging.
 */
export async function configureLogging(): Promise<void> {
  mkdirSync(LOGS_DIR, { recursive: true });

  const level = resolveLevel();
  const formatter = getJsonLinesFormatter();

  const stderrSink = getStreamSink(
    new WritableStream({ write: (c: string) => void process.stderr.write(c) }),
    { formatter },
  );
  const mcpFileSink = getRotatingFileSink(join(LOGS_DIR, "mcp.log"), {
    maxSize: MAX_FILE_SIZE,
    maxFiles: MAX_FILES,
    formatter,
  });
  const errorBaseFileSink = getRotatingFileSink(join(LOGS_DIR, "error.log"), {
    maxSize: MAX_FILE_SIZE,
    maxFiles: MAX_FILES,
    formatter,
  });

  // Wrap the error file sink to only pass warning and error records through.
  const ERROR_LEVELS = new Set<LogTapeLevel>(["warning", "error", "fatal"]);
  const errorFileSink: Sink = (record) => {
    if (ERROR_LEVELS.has(record.level)) errorBaseFileSink(record);
  };

  const clientLogging = process.env.BAB_CLIENT_LOG?.toLowerCase() !== "false";

  const sinks: Record<string, Sink> = {
    stderr: stderrSink,
    mcpFile: mcpFileSink,
    errorFile: errorFileSink,
  };

  if (clientLogging) {
    sinks.clientFile = createPerClientFileSink();
  }

  await configure({
    sinks,
    loggers: [
      {
        category: ["bab", "mcp"],
        lowestLevel: level,
        sinks: ["stderr", "mcpFile", "errorFile"],
      },
      {
        category: ["bab", "client"],
        lowestLevel: level,
        sinks: clientLogging ? ["stderr", "clientFile", "errorFile"] : ["stderr", "errorFile"],
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning" as LogTapeLevel,
        sinks: ["stderr"],
      },
    ],
  });
}

/** MCP server logger — server lifecycle, tool calls, protocol events. */
export const logger: WrappedLogger = wrap(["bab", "mcp"]);

/** Per-plugin client logger (e.g. opencode, copilot). Writes to <pluginId>.log */
export function getClientLogger(pluginId: string): WrappedLogger {
  return wrap(["bab", "client", pluginId]);
}

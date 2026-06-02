import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 1_000_000;

const RAW_CONCURRENCY = Number(process.env.BAB_MAX_CONCURRENT_PROCESSES);
const DEFAULT_MAX_CONCURRENT =
  Number.isFinite(RAW_CONCURRENCY) && RAW_CONCURRENCY > 0
    ? RAW_CONCURRENCY
    : 5;

const RAW_TIMEOUT = Number(process.env.BAB_CLI_TIMEOUT_MS);
export const DEFAULT_TIMEOUT_MS =
  Number.isFinite(RAW_TIMEOUT) && RAW_TIMEOUT > 0
    ? RAW_TIMEOUT
    : 300_000;

export interface ProcessRunOptions {
  args?: string[];
  command: string;
  cwd?: string;
  /** Explicit env for the child process. Callers must provide a sanitized env — no default. */
  env: Record<string, string>;
  input?: string;
  killGraceMs?: number;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export class ProcessRunner {
  private activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
  }

  get activeCount(): number {
    return this.activeProcesses.size;
  }

  async run(
    runId: string,
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const {
      args = [],
      command,
      cwd,
      env,
      input,
      killGraceMs = 5_000,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    if (this.activeProcesses.has(runId)) {
      throw new Error(`Process already active for run ${runId}`);
    }

    if (this.activeProcesses.size >= this.maxConcurrent) {
      throw new Error(
        `Process concurrency limit reached (${this.maxConcurrent}). ` +
          `Set BAB_MAX_CONCURRENT_PROCESSES to increase the limit.`,
      );
    }

    const resolvedCommand = Bun.which(command);

    if (!resolvedCommand) {
      throw new Error(`Command not found on PATH: ${command}`);
    }

    const startedAt = Date.now();
    let timedOut = false;
    let timeoutHandle: Timer | undefined;

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const child = spawn(resolvedCommand, args, {
        cwd,
        env,
        stdio: "pipe",
      });

      this.activeProcesses.set(runId, child);

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < MAX_CAPTURE_BYTES) {
          stdout += chunk;
        }
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_CAPTURE_BYTES) {
          stderr += chunk;
        }
      });

      child.on("error", (error) => {
        this.clearState(runId, timeoutHandle);
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        this.clearState(runId, timeoutHandle);
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode,
          signal,
          stderr,
          stdout,
          timedOut,
        });
      });

      if (typeof input === "string") {
        child.stdin.write(input);
      }

      child.stdin.end();

      timeoutHandle = setTimeout(() => {
        timedOut = true;

        if (!child.killed) {
          child.kill("SIGTERM");
        }

        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, killGraceMs).unref();
      }, timeoutMs);

      timeoutHandle.unref();
    });
  }

  async cancel(
    runId?: string,
    signal: NodeJS.Signals = "SIGTERM",
  ): Promise<void> {
    if (runId) {
      const child = this.activeProcesses.get(runId);

      if (!child) {
        return;
      }

      if (child.exitCode !== null) {
        this.activeProcesses.delete(runId);
        return;
      }

      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.kill(signal);
      });
      return;
    }

    await Promise.all(
      [...this.activeProcesses.keys()].map((id) => this.cancel(id, signal)),
    );
  }

  private clearState(runId: string, timeoutHandle?: Timer): void {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    this.activeProcesses.delete(runId);
  }
}

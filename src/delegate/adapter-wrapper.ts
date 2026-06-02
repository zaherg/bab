import type { DelegateEvent, PluginManifest } from "../types";
import {
  DEFAULT_TIMEOUT_MS,
  ProcessRunner,
  type ProcessRunResult,
} from "./process-runner";
import type {
  DelegatePluginAdapter,
  DelegateRunInput,
  SimpleAdapter,
} from "./types";

export function buildDelegateEvents(
  runId: string,
  providerId: string,
  parsed: { content: string; metadata: Record<string, unknown> },
  result: ProcessRunResult,
): DelegateEvent[] {
  const timestamp = new Date().toISOString();
  return [
    {
      content: parsed.content,
      content_type: "markdown",
      provider_id: providerId,
      run_id: runId,
      timestamp,
      type: "output",
    },
    {
      metadata: {
        ...parsed.metadata,
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
      },
      provider_id: providerId,
      run_id: runId,
      timestamp,
      type: "done",
    },
  ];
}

export function wrapSimpleAdapter(
  adapter: SimpleAdapter,
  manifest: PluginManifest,
): DelegatePluginAdapter {
  const runner = new ProcessRunner();
  return {
    cancel: (runId) => runner.cancel(runId),
    discover: adapter.discover?.bind(adapter),
    listModels: adapter.listModels?.bind(adapter),
    async run(input: DelegateRunInput) {
      const spec = adapter.buildCommand(input);
      const result = await runner.run(input.runId, {
        args: spec.args,
        command: spec.command ?? manifest.command,
        cwd: input.workingDirectory,
        env: spec.env ?? input.env,
        input: spec.stdin,
        timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (result.timedOut) {
        throw new Error(`${manifest.name} timed out`);
      }
      const parsed = adapter.parseResult(result, input);
      return buildDelegateEvents(input.runId, manifest.id, parsed, result);
    },
    validate: adapter.validate?.bind(adapter),
  };
}

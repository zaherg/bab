import type { DelegateEvent, PluginManifest } from "../types";

export interface ResolvedRole {
  args: Record<string, string | number | boolean>;
  name: string;
  prompt: string;
  source: "built_in" | "plugin";
}

export interface DelegateRunInput {
  env: Record<string, string>;
  prompt: string;
  role: ResolvedRole;
  runId: string;
  workingDirectory?: string;
}

export interface DelegatePluginAdapter {
  cancel?(runId?: string): Promise<void> | void;
  discover?(): Promise<Record<string, unknown>> | Record<string, unknown>;
  listModels?(): Promise<string[]> | string[];
  run(
    input: DelegateRunInput,
  ):
    | Promise<AsyncIterable<DelegateEvent> | DelegateEvent[]>
    | AsyncIterable<DelegateEvent>
    | DelegateEvent[];
  validate?(): Promise<void> | void;
}

export interface SimpleAdapter {
  buildCommand(input: DelegateRunInput): {
    args: string[];
    command?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };
  parseResult(
    result: import("./process-runner").ProcessRunResult,
    input: DelegateRunInput,
  ): { content: string; metadata: Record<string, unknown> };
  discover?(): Promise<Record<string, unknown>> | Record<string, unknown>;
  validate?(): Promise<void> | void;
  listModels?(): Promise<string[]> | string[];
}

export interface DiscoveredPlugin {
  adapterPath?: string;
  directory: string;
  manifestPath: string;
  sourceType?: "bundled" | "installed";
}

export interface LoadedPlugin {
  adapter?: DelegatePluginAdapter;
  adapterPath?: string;
  directory: string;
  manifest: PluginManifest;
  manifestPath: string;
  resolvedToolPrompts?: Record<string, string>;
}

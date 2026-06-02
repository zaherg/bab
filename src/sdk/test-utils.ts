import { type DelegateEvent, DelegateEventSchema } from "../types";

export interface MockProcessRunnerResult {
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}

export function createMockProcessRunner(result: MockProcessRunnerResult = {}) {
  return {
    async cancel() {
      return;
    },
    async run() {
      return {
        durationMs: result.durationMs ?? 0,
        exitCode: result.exitCode ?? 0,
        signal: result.signal ?? null,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
        timedOut: result.timedOut ?? false,
      };
    },
  };
}

export function assertDelegateEvents(events: unknown[]): DelegateEvent[] {
  return events.map((event) => DelegateEventSchema.parse(event));
}

export function createDoneEvent(
  overrides: Partial<DelegateEvent> = {},
): DelegateEvent {
  return DelegateEventSchema.parse({
    metadata: {},
    provider_id: "test-provider",
    run_id: "test-run",
    timestamp: new Date("2026-03-10T12:00:00.000Z").toISOString(),
    type: "done",
    ...overrides,
  });
}

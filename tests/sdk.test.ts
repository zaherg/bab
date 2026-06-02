import { describe, expect, test } from "bun:test";

import {
  assertDelegateEvents,
  createDoneEvent,
  createMockProcessRunner,
} from "../src/sdk";

describe("plugin sdk", () => {
  test("creates a reusable mock process runner", async () => {
    const runner = createMockProcessRunner({
      stdout: "hello",
      timedOut: true,
    });
    const result = await runner.run();

    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBeTrue();
  });

  test("validates delegate events through sdk helpers", () => {
    const doneEvent = createDoneEvent({
      provider_id: "plugin",
      run_id: "run_123",
    });
    const events = assertDelegateEvents([doneEvent]);

    expect(events[0]?.type).toBe("done");
    expect(events[0]?.provider_id).toBe("plugin");
  });
});

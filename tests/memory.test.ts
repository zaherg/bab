import { describe, expect, test } from "bun:test";

import {
  ConversationStore,
  MAX_THREAD_TURNS,
} from "../src/memory/conversations";
import { InMemoryStorageAdapter } from "../src/memory/memory";

describe("InMemoryStorageAdapter", () => {
  test("supports the storage contract", async () => {
    const adapter = new InMemoryStorageAdapter<number>();

    await adapter.set("alpha", 1);
    await adapter.set("beta", 2);

    expect(await adapter.get("alpha")).toBe(1);
    expect(await adapter.list()).toEqual([
      { key: "alpha", value: 1 },
      { key: "beta", value: 2 },
    ]);

    await adapter.delete("alpha");

    expect(await adapter.get("alpha")).toBeUndefined();
  });
});

describe("ConversationStore", () => {
  test("creates, updates, and deletes threads", async () => {
    const store = new ConversationStore();
    const thread = await store.createThread("thread-1");

    expect(thread.id).toBe("thread-1");
    expect(thread.turns).toEqual([]);

    const updatedThread = await store.addTurn("thread-1", {
      content: "hello",
      tool_name: "chat",
    });

    expect(updatedThread.turns).toHaveLength(1);
    expect(updatedThread.turns[0]?.content).toBe("hello");

    await store.deleteThread("thread-1");

    expect(await store.getThread("thread-1")).toBeUndefined();
  });

  test("enforces the twenty-turn limit", async () => {
    const store = new ConversationStore();

    for (let index = 1; index <= MAX_THREAD_TURNS + 5; index += 1) {
      await store.addTurn("thread-limit", {
        content: `turn-${index}`,
        created_at: `2026-03-10T12:00:${String(index).padStart(2, "0")}.000Z`,
        tool_name: "chat",
      });
    }

    const thread = await store.getThread("thread-limit");

    expect(thread?.turns).toHaveLength(MAX_THREAD_TURNS);
    expect(thread?.turns[0]?.content).toBe("turn-6");
    expect(thread?.turns.at(-1)?.content).toBe("turn-25");
  });

  test("drops oldest turn when 21st turn is added", async () => {
    const store = new ConversationStore();

    for (let i = 1; i <= 21; i++) {
      await store.addTurn("thread-21", {
        content: `turn-${i}`,
        created_at: `2026-03-10T12:00:${String(i).padStart(2, "0")}.000Z`,
        tool_name: "chat",
      });
    }

    const thread = await store.getThread("thread-21");

    // (a) only 20 turns retained
    expect(thread?.turns).toHaveLength(MAX_THREAD_TURNS);
    // (b) oldest turn (turn-1) is dropped
    expect(thread?.turns[0]?.content).toBe("turn-2");
    // (c) newest turn (turn-21) is present
    expect(thread?.turns.at(-1)?.content).toBe("turn-21");
  });

  test("resolves continuation ids to stored threads", async () => {
    const store = new ConversationStore();

    await store.addTurn("continuation-1", {
      content: "step-1",
      tool_name: "planner",
    });

    const resolved = await store.resolveContinuation("continuation-1");

    expect(resolved?.id).toBe("continuation-1");
    expect(resolved?.turns[0]?.tool_name).toBe("planner");
  });
});

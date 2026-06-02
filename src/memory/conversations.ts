import { logger } from "../utils/logger";
import type { StorageAdapter } from "./interface";
import { InMemoryStorageAdapter } from "./memory";

export const MAX_THREAD_TURNS = 20;

export interface ConversationTurn {
  content: string;
  created_at: string;
  tool_name: string;
}

export interface ConversationThread {
  created_at: string;
  id: string;
  turns: ConversationTurn[];
  updated_at: string;
}

export class ConversationStore {
  constructor(
    private readonly storage: StorageAdapter<ConversationThread> = new InMemoryStorageAdapter<ConversationThread>(),
  ) {
    logger.warn(
      "ConversationStore is in-memory only — all conversation threads will be lost on server restart",
    );
  }

  async createThread(threadId?: string): Promise<ConversationThread> {
    const id = threadId ?? crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const thread: ConversationThread = {
      created_at: timestamp,
      id,
      turns: [],
      updated_at: timestamp,
    };

    await this.storage.set(this.threadKey(thread.id), thread);
    return thread;
  }

  async addTurn(
    continuationId: string,
    turn: Omit<ConversationTurn, "created_at"> & { created_at?: string },
  ): Promise<ConversationThread> {
    const existingThread =
      (await this.getThread(continuationId)) ??
      (await this.createThread(continuationId));
    const createdAt = turn.created_at ?? new Date().toISOString();
    const nextTurns = [
      ...existingThread.turns,
      {
        content: turn.content,
        created_at: createdAt,
        tool_name: turn.tool_name,
      },
    ].slice(-MAX_THREAD_TURNS);

    const updatedThread: ConversationThread = {
      ...existingThread,
      turns: nextTurns,
      updated_at: createdAt,
    };

    await this.storage.set(this.threadKey(continuationId), updatedThread);
    return updatedThread;
  }

  async getThread(
    continuationId: string,
  ): Promise<ConversationThread | undefined> {
    return this.storage.get(this.threadKey(continuationId));
  }

  async listThreads(): Promise<ConversationThread[]> {
    const items = await this.storage.list("thread:");

    return items
      .map((item) => item.value)
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  }

  async deleteThread(continuationId: string): Promise<void> {
    await this.storage.delete(this.threadKey(continuationId));
  }

  async resolveContinuation(
    continuationId?: string,
  ): Promise<ConversationThread | undefined> {
    if (!continuationId) {
      return undefined;
    }

    return this.getThread(continuationId);
  }

  private threadKey(continuationId: string): string {
    return `thread:${continuationId}`;
  }
}

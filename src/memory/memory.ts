import { logger } from "../utils/logger";
import type { StorageAdapter } from "./interface";

const DEFAULT_MAX_ENTRIES = 1000;

export class InMemoryStorageAdapter<T> implements StorageAdapter<T> {
  private readonly store = new Map<string, T>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  async get(key: string): Promise<T | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;

      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        logger.warn(
          "In-memory store evicted oldest entry — conversation context lost",
          {
            evicted_key: oldestKey,
            max_entries: this.maxEntries,
          },
        );
      }
    }

    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: string): Promise<Array<{ key: string; value: T }>> {
    return Array.from(this.store.entries())
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([key, value]) => ({
        key,
        value,
      }));
  }
}

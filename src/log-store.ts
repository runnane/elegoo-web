export type LogDirection = 'sent' | 'received';

export interface LogEntry {
  timestamp: number;
  direction: LogDirection;
  topic: string;
  method?: number;
  type?: string; // PING/PONG/register etc.
  payload: string; // truncated JSON string
  raw: unknown; // full parsed object
}

const MAX_ENTRIES = 500;

export class LogStore {
  private entries: LogEntry[] = [];
  private listeners: (() => void)[] = [];

  add(direction: LogDirection, topic: string, data: unknown): void {
    const parsed = data as Record<string, unknown>;
    const entry: LogEntry = {
      timestamp: Date.now(),
      direction,
      topic,
      method: parsed?.method as number | undefined,
      type: parsed?.type as string | undefined,
      payload: JSON.stringify(data).slice(0, 500),
      raw: data,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    for (const listener of this.listeners) {
      listener();
    }
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}

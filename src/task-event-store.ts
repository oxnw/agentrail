import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPLAY_WINDOW_HOURS = 72;
const REPLAY_WINDOW_MS = REPLAY_WINDOW_HOURS * 60 * 60 * 1000;

export class CursorExpiredError extends Error {
  cursor: string;

  constructor(cursor: string) {
    super(`The requested stream cursor is no longer available: ${cursor}`);
    this.name = "CursorExpiredError";
    this.cursor = cursor;
  }
}

export interface TaskEvent {
  id: string;
  type: string;
  occurredAt: string;
  sequence: number;
  taskVersion: number;
  traceId: string;
  data: {
    taskId: string;
    taskIdentifier?: string;
    status?: string;
    previousStatus?: string;
    changedFields?: string[];
    actor?: { id: string; role: string };
    summary?: string;
    availableActions?: string[];
    links?: Record<string, string | null>;
    [key: string]: unknown;
  };
}

export interface TaskEventStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

export type Listener = (event: TaskEvent) => void;

export class TaskEventStore {
  private _events: TaskEvent[];
  private expiredCursors: Set<string>;
  private listeners: Set<Listener>;
  readonly now: () => Date;
  readonly storagePath: string | undefined;

  constructor({ now = () => new Date(), storagePath }: TaskEventStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    this._events = loadEvents(storagePath);
    this.expiredCursors = new Set();
    this.listeners = new Set();
  }

  get replayWindowHours(): number { return REPLAY_WINDOW_HOURS; }

  get events(): TaskEvent[] { return this._events; }

  getMaxSequence(): number {
    return this._events.at(-1)?.sequence ?? 0;
  }

  async append(event: TaskEvent): Promise<void> {
    this.pruneExpired();
    this._events.push(structuredClone(event));
    persistEvent(this.storagePath, event);
    for (const listener of this.listeners) {
      listener(structuredClone(event));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  pruneExpired(now: Date = this.now()): void {
    const cutoff = new Date(now).getTime() - REPLAY_WINDOW_MS;
    const retained: TaskEvent[] = [];
    for (const event of this._events) {
      const occurredAt = new Date(event.occurredAt).getTime();
      if (occurredAt < cutoff) {
        this.expiredCursors.add(event.id);
        this.expiredCursors.add(String(event.sequence));
        continue;
      }
      retained.push(event);
    }
    this._events = retained;
  }

  resolveCursor(cursor: string): TaskEvent {
    this.pruneExpired();
    const event = this._events.find(entry => entry.id === cursor || String(entry.sequence) === cursor);
    if (event) return event;
    if (this.expiredCursors.has(cursor)) throw new CursorExpiredError(cursor);
    throw new CursorExpiredError(cursor);
  }

  getEventsAfter(sequence: number, filters: FilterOptions = {}): TaskEvent[] {
    this.pruneExpired();
    return this._events.filter(event => event.sequence > sequence && matchesFilters(event, filters));
  }
}

export interface FilterOptions {
  taskId?: string;
  eventTypes?: Set<string>;
}

export function matchesFilters(event: TaskEvent, filters: FilterOptions = {}): boolean {
  const { taskId, eventTypes } = filters;
  if (taskId && event.data.taskId !== taskId) return false;
  if (eventTypes?.size && !eventTypes.has(event.type)) return false;
  return true;
}

function loadEvents(storagePath: string | undefined): TaskEvent[] {
  if (!storagePath || !existsSync(storagePath)) return [];
  return readFileSync(storagePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TaskEvent);
}

function persistEvent(storagePath: string | undefined, event: TaskEvent): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  appendFileSync(storagePath, `${JSON.stringify(event)}\n`, "utf8");
}
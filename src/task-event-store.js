// @ts-nocheck
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPLAY_WINDOW_HOURS = 72;
const REPLAY_WINDOW_MS = REPLAY_WINDOW_HOURS * 60 * 60 * 1000;

export class CursorExpiredError extends Error {
  constructor(cursor) {
    super(`The requested stream cursor is no longer available: ${cursor}`);
    this.name = "CursorExpiredError";
    this.cursor = cursor;
  }
}

export class TaskEventStore {
  constructor({ now = () => new Date(), storagePath } = {}) {
    this.now = now;
    this.storagePath = storagePath;
    this.events = loadEvents(storagePath);
    this.expiredCursors = new Set();
    this.listeners = new Set();
  }

  get replayWindowHours() {
    return REPLAY_WINDOW_HOURS;
  }

  getMaxSequence() {
    return this.events.at(-1)?.sequence ?? 0;
  }

  async append(event) {
    this.pruneExpired();
    this.events.push(structuredClone(event));
    persistEvent(this.storagePath, event);

    for (const listener of this.listeners) {
      listener(structuredClone(event));
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pruneExpired(now = this.now()) {
    const cutoff = new Date(now).getTime() - REPLAY_WINDOW_MS;
    const retained = [];

    for (const event of this.events) {
      const occurredAt = new Date(event.occurredAt).getTime();
      if (occurredAt < cutoff) {
        this.expiredCursors.add(event.id);
        this.expiredCursors.add(String(event.sequence));
        continue;
      }

      retained.push(event);
    }

    this.events = retained;
  }

  resolveCursor(cursor) {
    this.pruneExpired();

    const event = this.events.find(
      (entry) => entry.id === cursor || String(entry.sequence) === cursor
    );
    if (event) {
      return event;
    }

    if (this.expiredCursors.has(cursor)) {
      throw new CursorExpiredError(cursor);
    }

    throw new CursorExpiredError(cursor);
  }

  getEventsAfter(sequence, filters = {}) {
    this.pruneExpired();
    return this.events.filter(
      (event) => event.sequence > sequence && matchesFilters(event, filters)
    );
  }
}

export function matchesFilters(event, filters = {}) {
  const { taskId, eventTypes } = filters;

  if (taskId && event.data.taskId !== taskId) {
    return false;
  }

  if (eventTypes?.size && !eventTypes.has(event.type)) {
    return false;
  }

  return true;
}

function loadEvents(storagePath) {
  if (!storagePath || !existsSync(storagePath)) {
    return [];
  }

  return readFileSync(storagePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function persistEvent(storagePath, event) {
  if (!storagePath) {
    return;
  }

  mkdirSync(path.dirname(storagePath), { recursive: true });
  appendFileSync(storagePath, `${JSON.stringify(event)}\n`, "utf8");
}

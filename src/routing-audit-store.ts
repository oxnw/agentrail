import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RoutingAuditRecord } from "./intake-routing-control-plane.ts";

export interface RoutingIdempotencyEntry<T = unknown> {
  fingerprint: string;
  response: T;
}

interface PersistedState {
  audits?: RoutingAuditRecord[];
  idempotencyEntries?: Array<[string, RoutingIdempotencyEntry]>;
}

const MAX_IDEMPOTENCY_ENTRIES = 1000;

export interface RoutingAuditStoreOptions {
  storagePath?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function warnInvalidState(storagePath: string | undefined, reason: string): void {
  if (!storagePath) return;
  process.emitWarning(`Ignoring invalid RoutingAuditStore state at ${storagePath}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  try {
    const content = readFileSync(storagePath, "utf8");
    if (!content.trim()) return {};
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && (parsed.audits === undefined || Array.isArray(parsed.audits)) && (parsed.idempotencyEntries === undefined || Array.isArray(parsed.idempotencyEntries))) {
      return parsed as PersistedState;
    }
    warnInvalidState(storagePath, "state object shape is unsupported");
    return {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      warnInvalidState(storagePath, error.message);
      return {};
    }
    throw error;
  }
}

function persistState(
  storagePath: string | undefined,
  audits: Map<string, RoutingAuditRecord>,
  idempotency: Map<string, RoutingIdempotencyEntry>,
): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    audits: [...audits.values()],
    idempotencyEntries: [...idempotency.entries()],
  };
  const tempPath = `${storagePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tempPath, storagePath);
}

export class RoutingAuditStore {
  private readonly storagePath: string | undefined;
  private readonly audits: Map<string, RoutingAuditRecord>;
  private readonly idempotency: Map<string, RoutingIdempotencyEntry>;

  constructor({ storagePath }: RoutingAuditStoreOptions = {}) {
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.audits = new Map(
      (state.audits ?? [])
        .filter(isRoutingAuditRecord)
        .map((record) => [record.decision.id, record]),
    );
    this.idempotency = new Map(filterIdempotencyEntries(state.idempotencyEntries ?? []));
    this.trimIdempotency();
  }

  getRoutingAudit(decisionId: string): RoutingAuditRecord | null {
    const audit = this.audits.get(decisionId) ?? null;
    return audit ? clone(audit) : null;
  }

  recordAudit(audit: RoutingAuditRecord): void {
    this.audits.set(audit.decision.id, clone(audit));
    this.persist();
  }

  getIdempotencyEntry<T = unknown>(key: string): RoutingIdempotencyEntry<T> | null {
    const entry = this.idempotency.get(key) ?? null;
    return entry ? clone(entry as RoutingIdempotencyEntry<T>) : null;
  }

  setIdempotencyEntry<T = unknown>(key: string, entry: RoutingIdempotencyEntry<T>): void {
    if (this.idempotency.has(key)) {
      this.idempotency.delete(key);
    }
    this.idempotency.set(key, clone(entry));
    this.trimIdempotency();
    this.persist();
  }

  private persist(): void {
    persistState(this.storagePath, this.audits, this.idempotency);
  }

  private trimIdempotency(): void {
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldestKey = this.idempotency.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.idempotency.delete(oldestKey);
    }
  }
}

function isRoutingAuditRecord(value: unknown): value is RoutingAuditRecord {
  return (
    isRecord(value) &&
    isRecord(value.decision) &&
    typeof value.decision.id === "string" &&
    typeof value.inputDigest === "string" &&
    isRecord(value.ruleSet) &&
    typeof value.ruleSet.id === "string" &&
    typeof value.ruleSet.version === "number" &&
    typeof value.createdAt === "string"
  );
}

function filterIdempotencyEntries(entries: Array<[string, RoutingIdempotencyEntry]>): Array<[string, RoutingIdempotencyEntry]> {
  return entries.filter((entry): entry is [string, RoutingIdempotencyEntry] =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    isRecord(entry[1]) &&
    typeof entry[1].fingerprint === "string" &&
    "response" in entry[1],
  );
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface RoutingAuditStoreOptions {
  storagePath?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  const content = readFileSync(storagePath, "utf8");
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as PersistedState;
  }
  return {};
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
  writeFileSync(storagePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export class RoutingAuditStore {
  private readonly storagePath: string | undefined;
  private readonly audits: Map<string, RoutingAuditRecord>;
  private readonly idempotency: Map<string, RoutingIdempotencyEntry>;

  constructor({ storagePath }: RoutingAuditStoreOptions = {}) {
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.audits = new Map((state.audits ?? []).map((record) => [record.decision.id, record]));
    this.idempotency = new Map(state.idempotencyEntries ?? []);
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
    this.idempotency.set(key, clone(entry));
    this.persist();
  }

  private persist(): void {
    persistState(this.storagePath, this.audits, this.idempotency);
  }
}

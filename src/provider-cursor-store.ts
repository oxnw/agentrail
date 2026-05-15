import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProviderCursorProvider = "github";
export type ProviderCursorResource = "issues";

export interface ProviderCursorKey {
  provider: ProviderCursorProvider;
  resource: ProviderCursorResource;
  repository: string;
}

export interface ProviderCursorRecord extends ProviderCursorKey {
  cursor: string;
  updatedAt: string;
}

interface PersistedState {
  cursors?: ProviderCursorRecord[];
}

export interface ProviderCursorStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnInvalidState(storagePath: string | undefined, reason: string): void {
  if (!storagePath) return;
  process.emitWarning(`Ignoring invalid ProviderCursorStore state at ${storagePath}: ${reason}`);
}

function normalizeCursorRecord(value: unknown): ProviderCursorRecord | null {
  if (!isRecord(value)) return null;
  if (value.provider !== "github" || value.resource !== "issues") return null;
  const repository = typeof value.repository === "string" ? value.repository.trim() : "";
  const cursor = typeof value.cursor === "string" ? value.cursor.trim() : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt.trim() : "";
  if (!repository || !cursor || !updatedAt) return null;
  return {
    provider: "github",
    resource: "issues",
    repository,
    cursor,
    updatedAt,
  };
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  try {
    const content = readFileSync(storagePath, "utf8");
    if (!content.trim()) return {};
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && (parsed.cursors === undefined || Array.isArray(parsed.cursors))) {
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

function persistState(storagePath: string | undefined, cursors: Map<string, ProviderCursorRecord>): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    cursors: [...cursors.values()],
  };
  const tempPath = `${storagePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tempPath, storagePath);
}

function cursorKey({ provider, resource, repository }: ProviderCursorKey): string {
  return `${provider}:${resource}:${repository.trim()}`;
}

export class ProviderCursorStore {
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;
  private readonly cursors: Map<string, ProviderCursorRecord>;

  constructor({ now = () => new Date(), storagePath }: ProviderCursorStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.cursors = new Map(
      (state.cursors ?? [])
        .map(normalizeCursorRecord)
        .filter((record): record is ProviderCursorRecord => record !== null)
        .map((record) => [cursorKey(record), record]),
    );
  }

  getCursor(key: ProviderCursorKey): string | null {
    return this.cursors.get(cursorKey(key))?.cursor ?? null;
  }

  setCursor(key: ProviderCursorKey, cursor: string): ProviderCursorRecord {
    const repository = key.repository.trim();
    const normalizedCursor = cursor.trim();
    if (!repository) {
      throw new Error("Provider cursor repository is required.");
    }
    if (!normalizedCursor) {
      throw new Error("Provider cursor value is required.");
    }

    const record: ProviderCursorRecord = {
      provider: key.provider,
      resource: key.resource,
      repository,
      cursor: normalizedCursor,
      updatedAt: this.now().toISOString(),
    };
    this.cursors.set(cursorKey(record), record);
    this.persist();
    return clone(record);
  }

  private persist(): void {
    persistState(this.storagePath, this.cursors);
  }
}

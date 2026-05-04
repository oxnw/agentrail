import { randomUUID } from "node:crypto";

export interface WaitlistAddInput {
  email: string;
  name?: string | null;
  teamName?: string | null;
  teamSize?: number | null;
  agentFramework?: string | null;
  message?: string | null;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  teamName: string | null;
  teamSize: number | null;
  agentFramework: string | null;
  message: string | null;
  createdAt: string;
}

export interface AddEntryResult {
  entry: WaitlistEntry;
  alreadyExists: boolean;
}

export interface WaitlistListResult {
  entries: WaitlistEntry[];
  total: number;
}

export type NowFn = () => Date;

export interface WaitlistStoreOptions {
  now?: NowFn;
}

export class WaitlistStore {
  private now: NowFn;
  private entries: Map<string, WaitlistEntry>;
  private idempotencyKeys: Map<string, AddEntryResult>;

  constructor({ now = () => new Date() }: WaitlistStoreOptions = {}) {
    this.now = now;
    this.entries = new Map();
    this.idempotencyKeys = new Map();
  }

  addEntry(
    { email, name, teamName, teamSize, agentFramework, message }: WaitlistAddInput,
    idempotencyKey?: string
  ): AddEntryResult {
    if (!email || typeof email !== "string") {
      throw new WaitlistValidationError("email is required.");
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new WaitlistValidationError("Invalid email format.");
    }

    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      return this.idempotencyKeys.get(idempotencyKey)!;
    }

    for (const entry of this.entries.values()) {
      if (entry.email === normalizedEmail) {
        const result: AddEntryResult = { entry, alreadyExists: true };
        if (idempotencyKey) {
          this.idempotencyKeys.set(idempotencyKey, result);
        }
        return result;
      }
    }

    const id = `wl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const entry: WaitlistEntry = {
      id,
      email: normalizedEmail,
      name: name?.trim() || null,
      teamName: teamName?.trim() || null,
      teamSize: teamSize ?? null,
      agentFramework: agentFramework?.trim() || null,
      message: message?.trim() || null,
      createdAt: this.now().toISOString()
    };

    this.entries.set(id, entry);
    const result: AddEntryResult = { entry, alreadyExists: false };

    if (idempotencyKey) {
      this.idempotencyKeys.set(idempotencyKey, result);
    }

    return result;
  }

  listEntries(): WaitlistListResult {
    return {
      entries: [...this.entries.values()],
      total: this.entries.size
    };
  }
}

export class WaitlistValidationError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string) {
    super(message);
    this.name = "WaitlistValidationError";
    this.statusCode = 400;
    this.code = "validation_error";
  }
}

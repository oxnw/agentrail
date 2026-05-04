import { randomUUID } from "node:crypto";

export class WaitlistStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.entries = new Map();
    this.idempotencyKeys = new Map();
  }

  addEntry({ email, name, teamName, teamSize, agentFramework, message }, idempotencyKey) {
    if (!email || typeof email !== "string") {
      throw new WaitlistValidationError("email is required.");
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new WaitlistValidationError("Invalid email format.");
    }

    if (idempotencyKey && this.idempotencyKeys.has(idempotencyKey)) {
      return this.idempotencyKeys.get(idempotencyKey);
    }

    for (const entry of this.entries.values()) {
      if (entry.email === normalizedEmail) {
        const result = { entry, alreadyExists: true };
        if (idempotencyKey) {
          this.idempotencyKeys.set(idempotencyKey, result);
        }
        return result;
      }
    }

    const id = `wl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const entry = {
      id,
      email: normalizedEmail,
      name: name?.trim() || null,
      teamName: teamName?.trim() || null,
      teamSize: teamSize || null,
      agentFramework: agentFramework?.trim() || null,
      message: message?.trim() || null,
      createdAt: this.now().toISOString()
    };

    this.entries.set(id, entry);
    const result = { entry, alreadyExists: false };

    if (idempotencyKey) {
      this.idempotencyKeys.set(idempotencyKey, result);
    }

    return result;
  }

  listEntries() {
    return {
      entries: [...this.entries.values()],
      total: this.entries.size
    };
  }
}

export class WaitlistValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WaitlistValidationError";
    this.statusCode = 400;
    this.code = "validation_error";
  }
}

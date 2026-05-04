// @ts-nocheck
import crypto from "node:crypto";

const DEFAULT_RATE_LIMIT = {
  windowSeconds: 60,
  maxRequests: 600
};

const SUPPORTED_SCOPES = new Set([
  "auth:admin",
  "ci:read",
  "events:read",
  "reviews:read",
  "ship:write",
  "tasks:read",
  "tasks:write",
  "usage:read",
  "webhooks:read",
  "webhooks:write"
]);

export class AgentAuthError extends Error {
  constructor(message, { statusCode, code, details = {}, headers = {} }) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export class ValidationError extends AgentAuthError {
  constructor(message, details = {}) {
    super(message, {
      statusCode: 400,
      code: "validation_error",
      details: {
        ...details,
        availableActions: ["retry"]
      }
    });
  }
}

export class ConflictError extends AgentAuthError {
  constructor(message, details = {}) {
    super(message, {
      statusCode: 409,
      code: "conflict",
      details: {
        ...details,
        availableActions: ["retry"]
      }
    });
  }
}

export class UnauthorizedError extends AgentAuthError {
  constructor(message = "Authentication failed.", details = {}) {
    super(message, {
      statusCode: 401,
      code: "unauthorized",
      details: {
        ...details,
        availableActions: ["reauthenticate"]
      }
    });
  }
}

export class ScopeDeniedError extends AgentAuthError {
  constructor(requiredScope, keyScopes) {
    super("Agent API key does not grant the required scope.", {
      statusCode: 403,
      code: "insufficient_scope",
      details: {
        requiredScope,
        grantedScopes: keyScopes,
        availableActions: ["request_scope"]
      }
    });
  }
}

export class RateLimitExceededError extends AgentAuthError {
  constructor({ rateLimit, resetAt, retryAfterSeconds }) {
    super("Rate limit exceeded for this agent key.", {
      statusCode: 429,
      code: "rate_limited",
      details: {
        limit: rateLimit,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
        availableActions: ["retry"]
      },
      headers: {
        "retry-after": String(retryAfterSeconds)
      }
    });
  }
}

export class AgentAuthStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.keys = [];
    this.keyHashes = new Map();
    this.idempotencyEntries = new Map();
  }

  canBootstrap() {
    return this.keys.length === 0;
  }

  createKey(payload, idempotencyKey) {
    validateIdempotencyKey(idempotencyKey);
    const normalizedRequest = normalizeCreateKeyRequest(payload);
    const requestFingerprint = stableStringify(normalizedRequest);
    const entryKey = `create:${idempotencyKey}`;
    const existingEntry = this.idempotencyEntries.get(entryKey);

    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError("Idempotency-Key has already been used with a different request payload.", {
          idempotencyKey
        });
      }

      return structuredClone(existingEntry.response);
    }

    const { apiKey, keyHash } = generateApiKey();
    const key = {
      id: createId("akey"),
      keyHash,
      agent: normalizedRequest.agent,
      scopes: normalizedRequest.scopes,
      rateLimit: normalizedRequest.rateLimit,
      status: "active",
      createdAt: this.now().toISOString(),
      expiresAt: normalizedRequest.expiresAt,
      rotatedAt: null,
      rotatedFromKeyId: null,
      lastUsedAt: null,
      usage: createUsageState()
    };

    this.keys.push(key);
    this.keyHashes.set(keyHash, key);

    const response = toKeyResponse(key, apiKey);
    this.idempotencyEntries.set(entryKey, {
      requestFingerprint,
      response
    });

    return structuredClone(response);
  }

  rotateKey(keyId, payload = {}, idempotencyKey) {
    validateIdempotencyKey(idempotencyKey);
    const existingKey = this.findKey(keyId);
    if (existingKey.status !== "active") {
      throw new ConflictError("Agent API key is not active.", {
        keyId,
        currentStatus: existingKey.status
      });
    }

    const normalizedRequest = normalizeRotateKeyRequest(payload, existingKey);
    const requestFingerprint = stableStringify(normalizedRequest);
    const entryKey = `rotate:${keyId}:${idempotencyKey}`;
    const existingEntry = this.idempotencyEntries.get(entryKey);

    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError("Idempotency-Key has already been used with a different request payload.", {
          idempotencyKey
        });
      }

      return structuredClone(existingEntry.response);
    }

    const { apiKey, keyHash } = generateApiKey();
    const rotatedAt = this.now().toISOString();
    existingKey.status = "rotated";
    existingKey.rotatedAt = rotatedAt;
    this.keyHashes.delete(existingKey.keyHash);

    const rotatedKey = {
      id: createId("akey"),
      keyHash,
      agent: structuredClone(existingKey.agent),
      scopes: [...existingKey.scopes],
      rateLimit: { ...existingKey.rateLimit },
      status: "active",
      createdAt: rotatedAt,
      expiresAt: normalizedRequest.expiresAt,
      rotatedAt: null,
      rotatedFromKeyId: existingKey.id,
      lastUsedAt: null,
      usage: createUsageState()
    };

    this.keys.push(rotatedKey);
    this.keyHashes.set(keyHash, rotatedKey);

    const response = toKeyResponse(rotatedKey, apiKey);
    this.idempotencyEntries.set(entryKey, {
      requestFingerprint,
      response
    });

    return structuredClone(response);
  }

  authenticate({ authorizationHeader, requiredScope, operation }) {
    const apiKey = parseBearerToken(authorizationHeader);
    const keyHash = hashApiKey(apiKey);
    const key = this.keyHashes.get(keyHash);

    if (!key || key.status !== "active") {
      throw new UnauthorizedError();
    }

    if (key.expiresAt && new Date(key.expiresAt).getTime() <= this.now().getTime()) {
      recordDenied(key, "expired_key");
      throw new UnauthorizedError("Agent API key has expired.", {
        keyId: key.id
      });
    }

    if (!scopeAllows(key.scopes, requiredScope)) {
      recordDenied(key, "insufficient_scope");
      throw new ScopeDeniedError(requiredScope, key.scopes);
    }

    applyRateLimit(key, this.now());
    recordAccepted(key, requiredScope, operation, this.now());

    return {
      keyId: key.id,
      agent: structuredClone(key.agent),
      scopes: [...key.scopes]
    };
  }

  getUsage(keyId) {
    const key = this.findKey(keyId);
    const availableActions = key.status === "active" ? ["rotate"] : [];

    return {
      data: {
        keyId: key.id,
        agent: structuredClone(key.agent),
        status: key.status,
        lastUsedAt: key.lastUsedAt,
        totals: { ...key.usage.totals },
        byScope: entriesFromCounts(key.usage.byScope, "scope"),
        byOperation: entriesFromCounts(key.usage.byOperation, "operation"),
        rateLimit: {
          ...key.rateLimit,
          currentWindow: currentWindowState(key, this.now())
        },
        availableActions
      },
      availableActions
    };
  }

  findKey(keyId) {
    const key = this.keys.find((entry) => entry.id === keyId);
    if (!key) {
      throw new UnauthorizedError("Agent API key was not found.", {
        keyId
      });
    }

    return key;
  }
}

function normalizeCreateKeyRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const agent = normalizeAgent(payload.agent);
  const scopes = normalizeScopes(payload.scopes);
  const rateLimit = normalizeRateLimit(payload.rateLimit);

  return {
    agent,
    scopes,
    rateLimit,
    expiresAt: normalizeExpiresAt(payload.expiresAt)
  };
}

function normalizeRotateKeyRequest(payload, existingKey) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  return {
    expiresAt: normalizeExpiresAt(payload.expiresAt ?? existingKey.expiresAt)
  };
}

function normalizeAgent(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new ValidationError("`agent` is required.");
  }

  if (typeof agent.id !== "string" || !/^agt_[A-Za-z0-9_]+$/.test(agent.id)) {
    throw new ValidationError("`agent.id` must start with `agt_`.");
  }

  const externalIdentities = Array.isArray(agent.externalIdentities)
    ? agent.externalIdentities.map(normalizeExternalIdentity)
    : [];

  return {
    id: agent.id,
    displayName: typeof agent.displayName === "string" ? agent.displayName : agent.id,
    role: typeof agent.role === "string" ? agent.role : "agent",
    externalIdentities
  };
}

function normalizeExternalIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new ValidationError("`agent.externalIdentities` entries must be objects.");
  }

  if (typeof identity.provider !== "string" || identity.provider.length === 0) {
    throw new ValidationError("`agent.externalIdentities.provider` is required.");
  }

  if (typeof identity.subject !== "string" || identity.subject.length === 0) {
    throw new ValidationError("`agent.externalIdentities.subject` is required.");
  }

  return {
    provider: identity.provider,
    subject: identity.subject
  };
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ValidationError("`scopes` must contain at least one supported scope.");
  }

  const normalizedScopes = [...new Set(scopes)].sort();
  const unsupportedScope = normalizedScopes.find(
    (scope) => typeof scope !== "string" || !SUPPORTED_SCOPES.has(scope)
  );

  if (unsupportedScope) {
    throw new ValidationError("`scopes` contains an unsupported scope.", {
      unsupportedScope,
      supportedScopes: [...SUPPORTED_SCOPES].sort()
    });
  }

  return normalizedScopes;
}

function normalizeRateLimit(rateLimit = {}) {
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) {
    throw new ValidationError("`rateLimit` must be an object.");
  }

  const normalized = {
    windowSeconds: rateLimit.windowSeconds ?? DEFAULT_RATE_LIMIT.windowSeconds,
    maxRequests: rateLimit.maxRequests ?? DEFAULT_RATE_LIMIT.maxRequests
  };

  if (
    !Number.isInteger(normalized.windowSeconds) ||
    normalized.windowSeconds < 10 ||
    normalized.windowSeconds > 3600
  ) {
    throw new ValidationError("`rateLimit.windowSeconds` must be an integer from 10 to 3600.");
  }

  if (
    !Number.isInteger(normalized.maxRequests) ||
    normalized.maxRequests < 1 ||
    normalized.maxRequests > 10000
  ) {
    throw new ValidationError("`rateLimit.maxRequests` must be an integer from 1 to 10000.");
  }

  return normalized;
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt == null) {
    return null;
  }

  if (typeof expiresAt !== "string" || Number.isNaN(new Date(expiresAt).getTime())) {
    throw new ValidationError("`expiresAt` must be an RFC 3339 timestamp.");
  }

  return expiresAt;
}

function parseBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") {
    throw new UnauthorizedError();
  }

  const match = authorizationHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    throw new UnauthorizedError();
  }

  return match[1];
}

function scopeAllows(scopes, requiredScope) {
  return scopes.includes(requiredScope) || scopes.includes("auth:admin");
}

function applyRateLimit(key, now) {
  const windowMs = key.rateLimit.windowSeconds * 1000;
  const usage = key.usage.rateWindow;
  const nowMs = now.getTime();

  if (!usage.startedAt || nowMs >= new Date(usage.startedAt).getTime() + windowMs) {
    usage.startedAt = now.toISOString();
    usage.count = 0;
  }

  if (usage.count >= key.rateLimit.maxRequests) {
    const resetAtMs = new Date(usage.startedAt).getTime() + windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
    recordDenied(key, "rate_limited");
    throw new RateLimitExceededError({
      rateLimit: key.rateLimit,
      resetAt: new Date(resetAtMs).toISOString(),
      retryAfterSeconds
    });
  }

  usage.count += 1;
}

function recordAccepted(key, scope, operation, now) {
  key.lastUsedAt = now.toISOString();
  key.usage.totals.accepted += 1;
  incrementCount(key.usage.byScope, scope);
  incrementCount(key.usage.byOperation, operation);
}

function recordDenied(key, reason) {
  key.usage.totals.denied += 1;
  incrementCount(key.usage.denials, reason);
}

function createUsageState() {
  return {
    totals: {
      accepted: 0,
      denied: 0
    },
    byScope: {},
    byOperation: {},
    denials: {},
    rateWindow: {
      startedAt: null,
      count: 0
    }
  };
}

function currentWindowState(key, now) {
  const startedAt = key.usage.rateWindow.startedAt ?? now.toISOString();
  const resetAt = new Date(new Date(startedAt).getTime() + key.rateLimit.windowSeconds * 1000);
  const used = key.usage.rateWindow.startedAt ? key.usage.rateWindow.count : 0;

  return {
    startedAt,
    resetAt: resetAt.toISOString(),
    used,
    remaining: Math.max(0, key.rateLimit.maxRequests - used)
  };
}

function entriesFromCounts(counts, keyName) {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({
      [keyName]: name,
      count
    }));
}

function incrementCount(counts, name) {
  counts[name] = (counts[name] ?? 0) + 1;
}

function toKeyResponse(key, apiKey) {
  const availableActions = key.status === "active" ? ["rotate", "view_usage"] : ["view_usage"];

  return {
    data: {
      id: key.id,
      apiKey,
      agent: structuredClone(key.agent),
      scopes: [...key.scopes],
      rateLimit: { ...key.rateLimit },
      status: key.status,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      rotatedFromKeyId: key.rotatedFromKeyId,
      availableActions
    },
    availableActions
  };
}

function generateApiKey() {
  const apiKey = `ar_live_${crypto.randomBytes(32).toString("base64url")}`;

  return {
    apiKey,
    keyHash: hashApiKey(apiKey)
  };
}

function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function validateIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ValidationError("Idempotency-Key header is required.");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

import crypto from "node:crypto";

const DEFAULT_RATE_LIMIT = {
  windowSeconds: 60,
  maxRequests: 600
} as const;

const SUPPORTED_SCOPES = new Set([
  "auth:admin",
  "ci:read",
  "events:read",
  "routing:admin",
  "routing:evaluate",
  "routing:read",
  "reviews:read",
  "ship:write",
  "tasks:read",
  "tasks:write",
  "usage:read",
  "webhooks:read",
  "webhooks:write"
]);

export interface AgentAuthErrorOptions {
  statusCode: number;
  code: string;
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class AgentAuthError extends Error {
  statusCode: number;
  code: string;
  details: Record<string, unknown>;
  headers: Record<string, string>;

  constructor(message: string, { statusCode, code, details = {}, headers = {} }: AgentAuthErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export class ValidationError extends AgentAuthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      statusCode: 400,
      code: "validation_error",
      details: { ...details, availableActions: ["retry"] }
    });
  }
}

export class ConflictError extends AgentAuthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      statusCode: 409,
      code: "conflict",
      details: { ...details, availableActions: ["retry"] }
    });
  }
}

export class UnauthorizedError extends AgentAuthError {
  constructor(message = "Authentication failed.", details?: Record<string, unknown>) {
    super(message, {
      statusCode: 401,
      code: "unauthorized",
      details: { ...details, availableActions: ["reauthenticate"] }
    });
  }
}

export class ScopeDeniedError extends AgentAuthError {
  constructor(requiredScope: string, keyScopes: string[]) {
    super("Agent API key does not grant the required scope.", {
      statusCode: 403,
      code: "insufficient_scope",
      details: { requiredScope, grantedScopes: keyScopes, availableActions: ["request_scope"] }
    });
  }
}

export class RateLimitExceededError extends AgentAuthError {
  constructor(rateLimit: RateLimit, resetAt: string, retryAfterSeconds: number) {
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

export interface ExternalIdentity {
  provider: string;
  subject: string;
}

export interface AgentIdentity {
  id: string;
  displayName: string;
  role: string;
  externalIdentities: ExternalIdentity[];
}

export interface RateLimit {
  windowSeconds: number;
  maxRequests: number;
}

export interface UsageState {
  totals: { accepted: number; denied: number };
  byScope: Record<string, number>;
  byOperation: Record<string, number>;
  denials: Record<string, number>;
  rateWindow: { startedAt: string | null; count: number };
}

export interface ApiKeyRecord {
  id: string;
  keyHash: string;
  agent: AgentIdentity;
  scopes: string[];
  rateLimit: RateLimit;
  status: "active" | "rotated";
  createdAt: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  rotatedFromKeyId: string | null;
  lastUsedAt: string | null;
  usage: UsageState;
}

export interface CreateKeyPayload {
  agent: {
    id: string;
    displayName?: string;
    role?: string;
    externalIdentities?: Array<{ provider: string; subject: string }>;
  };
  scopes: string[];
  rateLimit?: { windowSeconds?: number; maxRequests?: number };
  expiresAt?: string | null;
}

export interface RotateKeyPayload {
  expiresAt?: string | null;
}

export interface ApiKeyResponseData {
  id: string;
  apiKey: string;
  agent: AgentIdentity;
  scopes: string[];
  rateLimit: RateLimit;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  rotatedFromKeyId: string | null;
  availableActions: string[];
}

export interface ApiKeyResponse {
  data: ApiKeyResponseData;
  availableActions: string[];
}

export interface AgentPrincipal {
  keyId: string;
  agent: AgentIdentity;
  scopes: string[];
}

export interface CurrentWindow {
  startedAt: string;
  resetAt: string;
  used: number;
  remaining: number;
}

export interface IdempotencyEntry {
  requestFingerprint: string;
  response: ApiKeyResponse;
}

export interface AgentAuthStoreOptions {
  now?: () => Date;
}

export interface UsageResponseData {
  keyId: string;
  agent: AgentIdentity;
  status: string;
  lastUsedAt: string | null;
  totals: { accepted: number; denied: number };
  byScope: Array<{ scope: string; count: number }>;
  byOperation: Array<{ operation: string; count: number }>;
  rateLimit: RateLimit & { currentWindow: CurrentWindow };
  availableActions: string[];
}

export interface UsageResponse {
  data: UsageResponseData;
  availableActions: string[];
}

function validateIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new ValidationError("Idempotency-Key header is required.");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function generateApiKey(): { apiKey: string; keyHash: string } {
  const apiKey = `ar_live_${crypto.randomBytes(32).toString("base64url")}`;
  return { apiKey, keyHash: crypto.createHash("sha256").update(apiKey).digest("hex") };
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function parseBearerToken(authorizationHeader: string | undefined): string {
  if (typeof authorizationHeader !== "string") throw new UnauthorizedError();
  const match = authorizationHeader.match(/^Bearer (.+)$/i);
  if (!match) throw new UnauthorizedError();
  return match[1];
}

function scopeAllows(scopes: string[], requiredScope: string): boolean {
  return scopes.includes(requiredScope) || scopes.includes("auth:admin");
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ValidationError("`scopes` must contain at least one supported scope.");
  }
  const normalizedScopes = [...new Set(scopes as string[])].sort();
  const unsupportedScope = normalizedScopes.find(
    scope => typeof scope !== "string" || !SUPPORTED_SCOPES.has(scope)
  );
  if (unsupportedScope) {
    throw new ValidationError("`scopes` contains an unsupported scope.", {
      unsupportedScope,
      supportedScopes: [...SUPPORTED_SCOPES].sort()
    });
  }
  return normalizedScopes;
}

function normalizeRateLimit(rateLimit: unknown): RateLimit {
  const rl = rateLimit ?? {};
  if (!rl || typeof rl !== "object" || Array.isArray(rl)) {
    throw new ValidationError("`rateLimit` must be an object.");
  }
  const rlo = rl as Record<string, unknown>;
  const normalized: RateLimit = {
    windowSeconds: typeof rlo.windowSeconds === "number" ? rlo.windowSeconds : DEFAULT_RATE_LIMIT.windowSeconds,
    maxRequests: typeof rlo.maxRequests === "number" ? rlo.maxRequests : DEFAULT_RATE_LIMIT.maxRequests
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

function normalizeExpiresAt(expiresAt: unknown): string | null {
  if (expiresAt == null) return null;
  if (typeof expiresAt !== "string" || Number.isNaN(new Date(expiresAt).getTime())) {
    throw new ValidationError("`expiresAt` must be an RFC 3339 timestamp.");
  }
  return expiresAt;
}

function normalizeAgent(agent: unknown): AgentIdentity {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new ValidationError("`agent` is required.");
  }
  const a = agent as Record<string, unknown>;
  if (typeof a.id !== "string" || !/^agt_[A-Za-z0-9_]+$/.test(a.id)) {
    throw new ValidationError("`agent.id` must start with `agt_`.");
  }
  const externalIdentities = Array.isArray(a.externalIdentities)
    ? a.externalIdentities.map((identity: unknown) => {
        if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
          throw new ValidationError("`agent.externalIdentities` entries must be objects.");
        }
        const i = identity as Record<string, unknown>;
        if (typeof i.provider !== "string" || i.provider.length === 0) {
          throw new ValidationError("`agent.externalIdentities.provider` is required.");
        }
        if (typeof i.subject !== "string" || i.subject.length === 0) {
          throw new ValidationError("`agent.externalIdentities.subject` is required.");
        }
        return { provider: i.provider, subject: i.subject };
      })
    : [];
  return {
    id: a.id,
    displayName: typeof a.displayName === "string" ? a.displayName : a.id,
    role: typeof a.role === "string" ? a.role : "agent",
    externalIdentities
  };
}

interface NormalizedCreate {
  agent: AgentIdentity;
  scopes: string[];
  rateLimit: RateLimit;
  expiresAt: string | null;
}

function normalizeCreateKeyRequest(payload: CreateKeyPayload | unknown): NormalizedCreate {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const p = payload as Record<string, unknown>;
  return {
    agent: normalizeAgent(p.agent),
    scopes: normalizeScopes(p.scopes),
    rateLimit: normalizeRateLimit(p.rateLimit),
    expiresAt: normalizeExpiresAt(p.expiresAt)
  };
}

interface NormalizedRotate {
  expiresAt: string | null;
}

function normalizeRotateKeyRequest(payload: RotateKeyPayload | unknown, existingKey: ApiKeyRecord): NormalizedRotate {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const p = payload as Record<string, unknown>;
  return {
    expiresAt: normalizeExpiresAt(p.expiresAt ?? existingKey.expiresAt)
  };
}

function createUsageState(): UsageState {
  return {
    totals: { accepted: 0, denied: 0 },
    byScope: {},
    byOperation: {},
    denials: {},
    rateWindow: { startedAt: null, count: 0 }
  };
}

function recordAccepted(key: ApiKeyRecord, scope: string, operation: string, now: Date): void {
  key.lastUsedAt = now.toISOString();
  key.usage.totals.accepted += 1;
  key.usage.byScope[scope] = (key.usage.byScope[scope] ?? 0) + 1;
  key.usage.byOperation[operation] = (key.usage.byOperation[operation] ?? 0) + 1;
}

function recordDenied(key: ApiKeyRecord, reason: string): void {
  key.usage.totals.denied += 1;
  key.usage.denials[reason] = (key.usage.denials[reason] ?? 0) + 1;
}

function currentWindowState(key: ApiKeyRecord, now: Date): CurrentWindow {
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

function applyRateLimit(key: ApiKeyRecord, now: Date): void {
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
    throw new RateLimitExceededError(key.rateLimit, new Date(resetAtMs).toISOString(), retryAfterSeconds);
  }
  usage.count += 1;
}

function toKeyResponse(key: ApiKeyRecord, apiKey: string): ApiKeyResponse {
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

export class AgentAuthStore {
  private now: () => Date;
  private keys: ApiKeyRecord[];
  private keyHashes: Map<string, ApiKeyRecord>;
  private idempotencyEntries: Map<string, IdempotencyEntry>;

  constructor({ now = () => new Date() }: AgentAuthStoreOptions = {}) {
    this.now = now;
    this.keys = [];
    this.keyHashes = new Map();
    this.idempotencyEntries = new Map();
  }

  canBootstrap(): boolean {
    return this.keys.length === 0;
  }

  createKey(payload: CreateKeyPayload, idempotencyKey: string): ApiKeyResponse {
    validateIdempotencyKey(idempotencyKey);
    const normalizedRequest = normalizeCreateKeyRequest(payload);
    const requestFingerprint = stableStringify(normalizedRequest);
    const entryKey = `create:${idempotencyKey}`;
    const existingEntry = this.idempotencyEntries.get(entryKey);
    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError("Idempotency-Key has already been used with a different request payload.", { idempotencyKey });
      }
      return structuredClone(existingEntry.response);
    }
    const { apiKey, keyHash } = generateApiKey();
    const key: ApiKeyRecord = {
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
    this.idempotencyEntries.set(entryKey, { requestFingerprint, response });
    return structuredClone(response);
  }

  rotateKey(keyId: string, payload: RotateKeyPayload, idempotencyKey: string): ApiKeyResponse {
    validateIdempotencyKey(idempotencyKey);
    const existingKey = this.findKey(keyId);
    if (existingKey.status !== "active") {
      throw new ConflictError("Agent API key is not active.", { keyId, currentStatus: existingKey.status });
    }
    const normalizedRequest = normalizeRotateKeyRequest(payload, existingKey);
    const requestFingerprint = stableStringify(normalizedRequest);
    const entryKey = `rotate:${keyId}:${idempotencyKey}`;
    const existingEntry = this.idempotencyEntries.get(entryKey);
    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError("Idempotency-Key has already been used with a different request payload.", { idempotencyKey });
      }
      return structuredClone(existingEntry.response);
    }
    const { apiKey, keyHash } = generateApiKey();
    const rotatedAt = this.now().toISOString();
    existingKey.status = "rotated";
    existingKey.rotatedAt = rotatedAt;
    this.keyHashes.delete(existingKey.keyHash);
    const rotatedKey: ApiKeyRecord = {
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
    this.idempotencyEntries.set(entryKey, { requestFingerprint, response });
    return structuredClone(response);
  }

  authenticate({ authorizationHeader, requiredScope, operation }: {
    authorizationHeader: string | undefined; requiredScope: string; operation: string;
  }): AgentPrincipal {
    const apiKey = parseBearerToken(authorizationHeader);
    const keyHash = hashApiKey(apiKey);
    const key = this.keyHashes.get(keyHash);
    if (!key || key.status !== "active") {
      throw new UnauthorizedError();
    }
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= this.now().getTime()) {
      recordDenied(key, "expired_key");
      throw new UnauthorizedError("Agent API key has expired.", { keyId: key.id });
    }
    if (!scopeAllows(key.scopes, requiredScope)) {
      recordDenied(key, "insufficient_scope");
      throw new ScopeDeniedError(requiredScope, key.scopes);
    }
    applyRateLimit(key, this.now());
    recordAccepted(key, requiredScope, operation, this.now());
    return { keyId: key.id, agent: structuredClone(key.agent), scopes: [...key.scopes] };
  }

  getUsage(keyId: string): UsageResponse {
    const key = this.findKey(keyId);
    const availableActions = key.status === "active" ? ["rotate"] : [];
    return {
      data: {
        keyId: key.id,
        agent: structuredClone(key.agent),
        status: key.status,
        lastUsedAt: key.lastUsedAt,
        totals: { ...key.usage.totals },
        byScope: Object.entries(key.usage.byScope)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([scope, count]) => ({ scope, count })),
        byOperation: Object.entries(key.usage.byOperation)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([operation, count]) => ({ operation, count })),
        rateLimit: {
          ...key.rateLimit,
          currentWindow: currentWindowState(key, this.now())
        },
        availableActions
      },
      availableActions
    };
  }

  findKey(keyId: string): ApiKeyRecord {
    const key = this.keys.find(entry => entry.id === keyId);
    if (!key) {
      throw new UnauthorizedError("Agent API key was not found.", { keyId });
    }
    return key;
  }
}

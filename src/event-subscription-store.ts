import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const RETRY_POLICY = {
  maxAttempts: 8,
  initialBackoffSeconds: 10,
  maxBackoffSeconds: 3600
} as const;

type RetryPolicy = typeof RETRY_POLICY;

export const AGENTRAIL_EVENT_TYPES = [
  "task.updated",
  "task.reviewed",
  "task.shipped",
  "task.awaiting_user",
] as const;

export type AgentRailEventType = typeof AGENTRAIL_EVENT_TYPES[number];

const AGENTRAIL_EVENT_TYPE_SET = new Set<string>(AGENTRAIL_EVENT_TYPES);

export interface EventSubscriptionFilterSet {
  taskIds: string[];
}

export interface AgentRailEventSubscription {
  id: string;
  url: string;
  eventTypes: AgentRailEventType[];
  filters: EventSubscriptionFilterSet;
  secret: string;
  description: string | null;
  status: "active" | "disabled";
  createdAt: string;
  createdAfterSequence: number;
  disabledAt: string | null;
  disableReason: string | null;
}

export interface EventSubscriptionData {
  id: string;
  url: string;
  eventTypes: AgentRailEventType[];
  filters: EventSubscriptionFilterSet;
  status: "active" | "disabled";
  signingAlgorithm: "hmac_sha256";
  retryPolicy: RetryPolicy;
  createdAt: string;
  availableActions: string[];
}

export interface EventSubscriptionResponse {
  data: EventSubscriptionData;
  availableActions: string[];
}

export interface IdempotencyEntry {
  requestFingerprint: string;
  response: EventSubscriptionResponse;
}

export class ValidationError extends Error {
  name = "ValidationError";
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) { super(message); this.details = details; }
}

export class ConflictError extends Error {
  name = "ConflictError";
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) { super(message); this.details = details; }
}

export interface CreateEventSubscriptionPayload {
  url: string;
  eventTypes: AgentRailEventType[];
  secret: string;
  description?: string | null;
  filters?: { taskIds?: string[] } | null;
}

export interface AgentRailEventSubscriptionStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

export interface CreateEventSubscriptionOptions {
  createdAfterSequence?: number;
}

function validateIdempotencyKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128)
    throw new ValidationError("Idempotency-Key header is required.");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function createId(prefix: string): string { return `${prefix}_${crypto.randomBytes(10).toString("hex")}`; }

function normalizeCreatedAfterSequence(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

interface LoadedState {
  subscriptions?: AgentRailEventSubscription[];
  idempotencyEntries?: Array<[string, IdempotencyEntry]>;
}

function loadState(storagePath: string | undefined): LoadedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  try {
    return JSON.parse(readFileSync(storagePath, "utf8")) as LoadedState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.emitWarning(`Failed to load AgentRail event subscription state at ${storagePath}: ${message}`);
    return {};
  }
}

type NormalizedCreateRequest = {
  url: string; eventTypes: AgentRailEventType[]; secret: string;
  description: string | null; filters: EventSubscriptionFilterSet;
};

function normalizeCreateRequest(payload: CreateEventSubscriptionPayload | unknown): NormalizedCreateRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new ValidationError("Request body must be a JSON object.");
  const p = payload as Record<string, unknown>;
  if (typeof p.url !== "string" || p.url.length === 0) throw new ValidationError("`url` is required.");
  try {
    const parsedUrl = new URL(p.url);
    if (!/^https?:$/.test(parsedUrl.protocol))
      throw new ValidationError("`url` must be an http or https URI.");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("`url` must be a valid URI.");
  }
  if (!Array.isArray(p.eventTypes) || p.eventTypes.length === 0)
    throw new ValidationError("`eventTypes` must contain at least one event type.");
  if (p.eventTypes.some((eventType) => typeof eventType !== "string"))
    throw new ValidationError("`eventTypes` must contain only strings.");
  const normalizedEventTypes = [...new Set(p.eventTypes as string[])].sort();
  const unsupportedEventType = normalizedEventTypes.find((eventType) => !AGENTRAIL_EVENT_TYPE_SET.has(eventType));
  if (unsupportedEventType) {
    throw new ValidationError("`eventTypes` contains an unsupported event type.", {
      eventType: unsupportedEventType,
      supportedEventTypes: [...AGENTRAIL_EVENT_TYPES],
    });
  }
  if (typeof p.secret !== "string" || p.secret.length < 16 || p.secret.length > 128)
    throw new ValidationError("`secret` must be between 16 and 128 characters.");
  const rawFilters = p.filters;
  const rawTaskIds =
    rawFilters && typeof rawFilters === "object" && !Array.isArray(rawFilters)
      ? (rawFilters as Record<string, unknown>).taskIds
      : undefined;
  const normalizedTaskIds = [...new Set(Array.isArray(rawTaskIds) ? rawTaskIds : [])].sort() as string[];
  if (normalizedTaskIds.some((taskId) => typeof taskId !== "string"))
    throw new ValidationError("`filters.taskIds` must contain only strings.");
  return {
    url: p.url,
    eventTypes: normalizedEventTypes as AgentRailEventType[],
    secret: p.secret,
    description: typeof p.description === "string" ? p.description : null,
    filters: { taskIds: normalizedTaskIds }
  };
}

function toSubscriptionResponse(subscription: AgentRailEventSubscription): EventSubscriptionResponse {
  const availableActions = subscription.status === "active" ? ["deactivate"] : [];
  return {
    data: {
      id: subscription.id,
      url: subscription.url,
      eventTypes: [...subscription.eventTypes],
      filters: { taskIds: [...subscription.filters.taskIds] },
      status: subscription.status,
      signingAlgorithm: "hmac_sha256",
      retryPolicy: structuredClone(RETRY_POLICY),
      createdAt: subscription.createdAt,
      availableActions
    },
    availableActions
  };
}

export class AgentRailEventSubscriptionStore {
  private now: () => Date;
  private storagePath: string | undefined;
  private subscriptions: AgentRailEventSubscription[];
  private idempotencyEntries: Map<string, IdempotencyEntry>;

  constructor({ now = () => new Date(), storagePath }: AgentRailEventSubscriptionStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this.subscriptions = (state.subscriptions ?? []).map((subscription) => ({
      ...subscription,
      createdAfterSequence: normalizeCreatedAfterSequence(subscription.createdAfterSequence),
    }));
    this.idempotencyEntries = new Map(state.idempotencyEntries ?? []);
  }

  createSubscription(
    payload: CreateEventSubscriptionPayload,
    idempotencyKey: string,
    options: CreateEventSubscriptionOptions = {},
  ): EventSubscriptionResponse {
    validateIdempotencyKey(idempotencyKey);
    const normalizedRequest = normalizeCreateRequest(payload);
    const requestFingerprint = stableStringify(normalizedRequest);
    const existingEntry = this.idempotencyEntries.get(idempotencyKey);
    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError(
          "Idempotency-Key has already been used with a different request payload.",
          { idempotencyKey, availableActions: ["retry"] }
        );
      }
      return structuredClone(existingEntry.response);
    }
    const duplicate = this.subscriptions.find(
      (subscription) =>
        subscription.status === "active" &&
        subscription.url === normalizedRequest.url &&
        stableStringify(subscription.eventTypes) === stableStringify(normalizedRequest.eventTypes) &&
        stableStringify(subscription.filters.taskIds) ===
          stableStringify(normalizedRequest.filters.taskIds)
    );
    if (duplicate) {
      throw new ConflictError(
        "An active subscription already exists for this endpoint and filter set.",
        { subscriptionId: duplicate.id, availableActions: ["deactivate"] }
      );
    }
    const subscription: AgentRailEventSubscription = {
      id: createId("evsub"),
      url: normalizedRequest.url,
      eventTypes: normalizedRequest.eventTypes,
      filters: normalizedRequest.filters,
      secret: normalizedRequest.secret,
      description: normalizedRequest.description,
      status: "active",
      createdAt: this.now().toISOString(),
      createdAfterSequence: normalizeCreatedAfterSequence(options.createdAfterSequence),
      disabledAt: null,
      disableReason: null
    };
    this.subscriptions.push(subscription);
    const response = toSubscriptionResponse(subscription);
    this.idempotencyEntries.set(idempotencyKey, { requestFingerprint, response });
    this.persist();
    return structuredClone(response);
  }

  deactivateSubscription(subscriptionId: string, disableReason = "manual_deactivate"): EventSubscriptionResponse | null {
    const subscription = this.subscriptions.find((entry) => entry.id === subscriptionId);
    if (!subscription) return null;
    if (subscription.status !== "disabled") {
      subscription.status = "disabled";
      subscription.disabledAt = this.now().toISOString();
      subscription.disableReason = disableReason;
      this.persist();
    }
    return toSubscriptionResponse(subscription);
  }

  listSubscriptions(): { data: EventSubscriptionData[]; availableActions: ["create"] } {
    return {
      data: this.subscriptions.map((subscription) => toSubscriptionResponse(subscription).data),
      availableActions: ["create"]
    };
  }

  getSubscription(subscriptionId: string): EventSubscriptionResponse | null {
    const subscription = this.subscriptions.find((entry) => entry.id === subscriptionId);
    if (!subscription) return null;
    return toSubscriptionResponse(subscription);
  }

  listActiveSubscriptions(): AgentRailEventSubscription[] {
    return this.subscriptions
      .filter((subscription) => subscription.status === "active")
      .map((subscription) => structuredClone(subscription));
  }

  persist(): void {
    if (!this.storagePath) return;
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    writeFileSync(
      this.storagePath,
      JSON.stringify(
        {
          subscriptions: this.subscriptions,
          idempotencyEntries: [...this.idempotencyEntries.entries()]
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

export interface AgentRailEvent {
  id: string;
  type: string;
  sequence: number;
  data: { taskId?: string; [key: string]: unknown };
}

export function eventMatchesSubscription(event: AgentRailEvent, subscription: AgentRailEventSubscription): boolean {
  if (!subscription.eventTypes.includes(event.type as AgentRailEventType)) return false;
  const taskIds = subscription.filters.taskIds;
  if (taskIds.length > 0 && (!event.data.taskId || !taskIds.includes(event.data.taskId))) return false;
  return true;
}

export function signatureForPayload(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function retryPolicy(): RetryPolicy {
  return structuredClone(RETRY_POLICY);
}

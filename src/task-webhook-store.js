// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const RETRY_POLICY = {
  maxAttempts: 8,
  initialBackoffSeconds: 10,
  maxBackoffSeconds: 3600
};

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class ConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConflictError";
    this.details = details;
  }
}

export class TaskWebhookSubscriptionStore {
  constructor({ now = () => new Date(), storagePath } = {}) {
    this.now = now;
    this.storagePath = storagePath;

    const state = loadState(storagePath);
    this.subscriptions = state.subscriptions ?? [];
    this.idempotencyEntries = new Map(state.idempotencyEntries ?? []);
  }

  createSubscription(payload, idempotencyKey) {
    validateIdempotencyKey(idempotencyKey);
    const normalizedRequest = normalizeCreateRequest(payload);
    const requestFingerprint = stableStringify(normalizedRequest);

    const existingEntry = this.idempotencyEntries.get(idempotencyKey);
    if (existingEntry) {
      if (existingEntry.requestFingerprint !== requestFingerprint) {
        throw new ConflictError(
          "Idempotency-Key has already been used with a different request payload.",
          {
            idempotencyKey,
            availableActions: ["retry"]
          }
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
        {
          subscriptionId: duplicate.id,
          availableActions: ["deactivate"]
        }
      );
    }

    const subscription = {
      id: createId("whsub"),
      url: normalizedRequest.url,
      eventTypes: normalizedRequest.eventTypes,
      filters: normalizedRequest.filters,
      secret: normalizedRequest.secret,
      description: normalizedRequest.description,
      status: "active",
      createdAt: this.now().toISOString(),
      disabledAt: null,
      disableReason: null
    };

    this.subscriptions.push(subscription);

    const response = toSubscriptionResponse(subscription);
    this.idempotencyEntries.set(idempotencyKey, {
      requestFingerprint,
      response
    });
    this.persist();

    return structuredClone(response);
  }

  deactivateSubscription(subscriptionId, disableReason = "manual_deactivate") {
    const subscription = this.subscriptions.find((entry) => entry.id === subscriptionId);
    if (!subscription) {
      return null;
    }

    if (subscription.status !== "disabled") {
      subscription.status = "disabled";
      subscription.disabledAt = this.now().toISOString();
      subscription.disableReason = disableReason;
      this.persist();
    }

    return toSubscriptionResponse(subscription);
  }

  listSubscriptions() {
    return {
      data: this.subscriptions.map((subscription) => toSubscriptionResponse(subscription).data),
      availableActions: ["create"]
    };
  }

  getSubscription(subscriptionId) {
    const subscription = this.subscriptions.find((entry) => entry.id === subscriptionId);
    if (!subscription) {
      return null;
    }

    return toSubscriptionResponse(subscription);
  }

  listActiveSubscriptions() {
    return this.subscriptions
      .filter((subscription) => subscription.status === "active")
      .map((subscription) => structuredClone(subscription));
  }

  persist() {
    if (!this.storagePath) {
      return;
    }

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

export function eventMatchesSubscription(event, subscription) {
  if (!subscription.eventTypes.includes(event.type)) {
    return false;
  }

  const taskIds = subscription.filters.taskIds;
  if (taskIds.length > 0 && !taskIds.includes(event.data.taskId)) {
    return false;
  }

  return true;
}

export function signatureForPayload(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function retryPolicy() {
  return structuredClone(RETRY_POLICY);
}

function normalizeCreateRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  if (typeof payload.url !== "string" || payload.url.length === 0) {
    throw new ValidationError("`url` is required.");
  }

  try {
    const parsedUrl = new URL(payload.url);
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      throw new ValidationError("`url` must be an http or https URI.");
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError("`url` must be a valid URI.");
  }

  if (!Array.isArray(payload.eventTypes) || payload.eventTypes.length === 0) {
    throw new ValidationError("`eventTypes` must contain at least one event type.");
  }

  const normalizedEventTypes = [...new Set(payload.eventTypes)].sort();
  if (normalizedEventTypes.some((eventType) => typeof eventType !== "string")) {
    throw new ValidationError("`eventTypes` must contain only strings.");
  }

  if (typeof payload.secret !== "string" || payload.secret.length < 16 || payload.secret.length > 128) {
    throw new ValidationError("`secret` must be between 16 and 128 characters.");
  }

  const normalizedTaskIds = [
    ...new Set(Array.isArray(payload.filters?.taskIds) ? payload.filters.taskIds : [])
  ].sort();

  if (normalizedTaskIds.some((taskId) => typeof taskId !== "string")) {
    throw new ValidationError("`filters.taskIds` must contain only strings.");
  }

  return {
    url: payload.url,
    eventTypes: normalizedEventTypes,
    secret: payload.secret,
    description: typeof payload.description === "string" ? payload.description : null,
    filters: {
      taskIds: normalizedTaskIds
    }
  };
}

function toSubscriptionResponse(subscription) {
  const availableActions = subscription.status === "active" ? ["deactivate"] : [];

  return {
    data: {
      id: subscription.id,
      url: subscription.url,
      eventTypes: [...subscription.eventTypes],
      filters: {
        taskIds: [...subscription.filters.taskIds]
      },
      status: subscription.status,
      signingAlgorithm: "hmac_sha256",
      retryPolicy: retryPolicy(),
      createdAt: subscription.createdAt,
      availableActions
    },
    availableActions
  };
}

function loadState(storagePath) {
  if (!storagePath || !existsSync(storagePath)) {
    return {};
  }

  return JSON.parse(readFileSync(storagePath, "utf8"));
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

import crypto from "node:crypto";

import type { AgentTaskQueue } from "./agent-task-queue.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { TaskEventStore } from "./task-event-store.ts";
import type { TaskRecord } from "./task-store.ts";

const BODY_PREVIEW_MAX_LENGTH = 240;
const DEFAULT_SIGNATURE_TOLERANCE_MS = 60_000;

export interface LinearCommentWebhookAdapterOptions {
  now?: () => Date;
  eventStore: TaskEventStore;
  taskQueue: Pick<AgentTaskQueue, "findTasksByLinearIssueId" | "getIdempotencyEntry" | "setIdempotencyEntry">;
  apiBaseUrl?: string;
  webhookSecret?: string | null;
  signatureToleranceMs?: number;
}

export interface LinearWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

interface LinearActor {
  id: string | null;
  type: string | null;
  name: string | null;
  email: string | null;
  url: string | null;
}

interface LinearCommentPayload {
  action: string;
  type: string;
  createdAt: string | null;
  actor: LinearActor;
  data: {
    id: string;
    body: string;
    issueId: string;
  };
  url: string | null;
  webhookTimestamp: number | null;
  webhookId: string | null;
}

export interface LinearWebhookReceipt {
  data: {
    accepted: true;
    provider: "linear";
    eventType: string;
    action: string;
    deliveryId: string | null;
    commentId: string | null;
    linearIssueId: string | null;
    matchedTasks: string[];
    eventIds: string[];
    recorded: boolean;
    deduplicated: boolean;
    ignored: boolean;
    ignoredReason: string | null;
  };
  availableActions: string[];
}

interface LinearWebhookDedupeState {
  kind: "linear-comment-webhook-dedupe";
  receipt: LinearWebhookReceipt;
  processedTaskIds: string[];
  eventIds: string[];
  complete: boolean;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function getHeader(headers: LinearWebhookRequest["headers"], name: string): string | null {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePreview(body: string): string {
  const normalized = body.replace(/\s+/gu, " ").trim();
  if (normalized.length <= BODY_PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, BODY_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

function fingerprint(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

function verifyLinearSignature({ rawBody, signature, secret }: { rawBody: string; signature: string | null; secret: string }): boolean {
  if (!signature || !/^[a-f0-9]+$/iu.test(signature) || signature.length % 2 !== 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function parseCommentPayload(rawBody: string): LinearCommentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw new TaskLifecycleError(400, "validation_error", "Linear webhook payload is not valid JSON.", {
      availableActions: ["retry"],
      parseError: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    throw new TaskLifecycleError(400, "validation_error", "Linear webhook payload must be a JSON object.", {
      availableActions: ["retry"],
    });
  }

  const data = isRecord(parsed.data) ? parsed.data : null;
  const actor = isRecord(parsed.actor) ? parsed.actor : {};
  const issue = data && isRecord(data.issue) ? data.issue : null;
  const commentId = data ? stringOrNull(data.id) : null;
  const issueId = data ? stringOrNull(data.issueId) ?? stringOrNull(issue?.id) : null;

  if (parsed.type === "Comment" && parsed.action === "create" && (!commentId || !issueId)) {
    throw new TaskLifecycleError(400, "validation_error", "Linear Comment webhook payload is missing `data.id` or `data.issueId`.", {
      availableActions: ["retry"],
    });
  }

  return {
    action: stringOrNull(parsed.action) ?? "unknown",
    type: stringOrNull(parsed.type) ?? "unknown",
    createdAt: stringOrNull(parsed.createdAt),
    actor: {
      id: stringOrNull(actor.id),
      type: stringOrNull(actor.type),
      name: stringOrNull(actor.name),
      email: stringOrNull(actor.email),
      url: stringOrNull(actor.url),
    },
    data: {
      id: commentId ?? "",
      body: data ? stringOrNull(data.body) ?? "" : "",
      issueId: issueId ?? "",
    },
    url: stringOrNull(parsed.url),
    webhookTimestamp: numberOrNull(parsed.webhookTimestamp),
    webhookId: stringOrNull(parsed.webhookId),
  };
}

export class LinearCommentWebhookAdapter {
  private now: () => Date;
  private eventStore: TaskEventStore;
  private taskQueue: LinearCommentWebhookAdapterOptions["taskQueue"];
  private apiBaseUrl: string;
  private webhookSecret: string | null;
  private signatureToleranceMs: number;
  // This only deduplicates concurrent deliveries inside one process. Cross-instance
  // dedupe relies on the persisted idempotency entries written through taskQueue.
  private inFlightDedupeKeys: Set<string>;

  constructor({
    now = () => new Date(),
    eventStore,
    taskQueue,
    apiBaseUrl = "http://127.0.0.1:3000",
    webhookSecret = process.env.LINEAR_WEBHOOK_SECRET || null,
    signatureToleranceMs = DEFAULT_SIGNATURE_TOLERANCE_MS,
  }: LinearCommentWebhookAdapterOptions) {
    this.now = now;
    this.eventStore = eventStore;
    this.taskQueue = taskQueue;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.webhookSecret = webhookSecret;
    this.signatureToleranceMs = signatureToleranceMs;
    this.inFlightDedupeKeys = new Set();
  }

  async receiveWebhook({ headers, rawBody }: LinearWebhookRequest): Promise<LinearWebhookReceipt> {
    if (this.webhookSecret) {
      const signature = getHeader(headers, "linear-signature");
      if (!verifyLinearSignature({ rawBody, signature, secret: this.webhookSecret })) {
        throw new TaskLifecycleError(401, "linear_webhook_unauthorized", "Linear webhook signature is missing or invalid.", {
          availableActions: ["retry"],
        });
      }
    }

    const payload = parseCommentPayload(rawBody);
    this.verifyTimestamp(payload);

    const deliveryId = getHeader(headers, "linear-delivery");
    const linearIssueId = payload.data.issueId || null;
    const commentId = payload.data.id || null;

    if (payload.type !== "Comment" || payload.action !== "create") {
      return this.createReceipt({
        payload,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks: [],
        eventIds: [],
        recorded: false,
        deduplicated: false,
        ignoredReason: "unsupported_event",
      });
    }

    const matchedTasks = this.taskQueue.findTasksByLinearIssueId(payload.data.issueId);
    const matchedTaskIds = matchedTasks.map(task => task.id);

    if (matchedTasks.length === 0) {
      return this.createReceipt({
        payload,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks: [],
        eventIds: [],
        recorded: false,
        deduplicated: false,
        ignoredReason: "task_not_found",
      });
    }

    const incomingFingerprint = fingerprint(rawBody);
    const deliveryKey = deliveryId ? this.deliveryKey(deliveryId) : null;
    const commentKey = commentId ? this.commentKey(commentId) : null;
    const resumeState = this.findResumeState({
      deliveryKey,
      commentKey,
      incomingFingerprint,
      payload,
      deliveryId,
      commentId,
      linearIssueId,
      matchedTaskIds,
    });
    if (resumeState.duplicateReceipt) {
      return resumeState.duplicateReceipt;
    }

    const partialState = resumeState.partialState;
    const processedTaskIds = [...(partialState?.processedTaskIds ?? [])];
    const eventIds = [...(partialState?.eventIds ?? [])];

    if (deliveryKey && this.inFlightDedupeKeys.has(deliveryKey)) {
      return this.createReceipt({
        payload,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks: matchedTaskIds,
        eventIds: [],
        recorded: false,
        deduplicated: true,
        ignoredReason: "duplicate_delivery",
      });
    }

    if (commentKey && this.inFlightDedupeKeys.has(commentKey)) {
      return this.createReceipt({
        payload,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks: matchedTaskIds,
        eventIds: [],
        recorded: false,
        deduplicated: true,
        ignoredReason: "duplicate_comment",
      });
    }

    const inFlightKeys = [deliveryKey, commentKey].filter((key): key is string => Boolean(key));
    for (const key of inFlightKeys) this.inFlightDedupeKeys.add(key);

    try {
      try {
        for (const task of matchedTasks) {
          if (processedTaskIds.includes(task.id)) {
            continue;
          }
          const eventId = await this.appendCommentEvent({ task, payload, deliveryId });
          eventIds.push(eventId);
          processedTaskIds.push(task.id);
        }
      } catch (error) {
        if (eventIds.length > 0) {
          const partialReceipt = this.createReceipt({
            payload,
            deliveryId,
            commentId,
            linearIssueId,
            matchedTasks: matchedTaskIds,
            eventIds,
            recorded: false,
            deduplicated: false,
            ignoredReason: "partial_failure",
          });
          this.storeDedupeState({
            deliveryKey,
            commentKey,
            incomingFingerprint,
            state: {
              kind: "linear-comment-webhook-dedupe",
              receipt: partialReceipt,
              processedTaskIds,
              eventIds,
              complete: false,
            },
          });
        }
        throw error;
      }

      const receipt = this.createReceipt({
        payload,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks: matchedTaskIds,
        eventIds,
        recorded: true,
        deduplicated: false,
        ignoredReason: null,
      });
      this.storeDedupeState({
        deliveryKey,
        commentKey,
        incomingFingerprint,
        state: {
          kind: "linear-comment-webhook-dedupe",
          receipt,
          processedTaskIds: matchedTaskIds,
          eventIds,
          complete: true,
        },
      });

      return receipt;
    } finally {
      for (const key of inFlightKeys) this.inFlightDedupeKeys.delete(key);
    }
  }

  private async appendCommentEvent({
    task,
    payload,
    deliveryId,
  }: {
    task: TaskRecord;
    payload: LinearCommentPayload;
    deliveryId: string | null;
  }): Promise<string> {
    const eventId = createId("evt");
    const occurredAt = payload.createdAt ?? this.now().toISOString();
    const authorName = payload.actor.name ?? payload.actor.id ?? "Linear user";
    const bodyPreview = normalizePreview(payload.data.body);

    await this.eventStore.append({
      id: eventId,
      type: "task.comment.created",
      occurredAt,
      taskVersion: task.version,
      traceId: deliveryId ? `linear:${deliveryId}` : "linear:comment",
      data: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        status: task.status,
        actor: {
          id: payload.actor.id ?? "linear",
          role: payload.actor.type ? `linear:${payload.actor.type}` : "linear",
        },
        summary: `Linear comment from ${authorName}: ${bodyPreview}`,
        availableActions: task.availableActions,
        links: {
          task: `${this.apiBaseUrl}/tasks/${task.id}`,
          linearComment: payload.url,
        },
        provider: "linear",
        linearComment: {
          id: payload.data.id,
          url: payload.url,
          deliveryId,
          createdAt: occurredAt,
          bodyPreview,
          author: {
            id: payload.actor.id,
            type: payload.actor.type,
            name: payload.actor.name,
            url: payload.actor.url,
          },
        },
      },
    });

    return eventId;
  }

  private verifyTimestamp(payload: LinearCommentPayload): void {
    if (!this.webhookSecret) return;

    if (payload.webhookTimestamp === null) {
      throw new TaskLifecycleError(401, "linear_webhook_unauthorized", "Linear webhook timestamp is missing or invalid.", {
        availableActions: ["retry"],
      });
    }

    const ageMs = Math.abs(this.now().getTime() - payload.webhookTimestamp);
    if (ageMs > this.signatureToleranceMs) {
      throw new TaskLifecycleError(401, "linear_webhook_unauthorized", "Linear webhook timestamp is outside the accepted replay window.", {
        availableActions: ["retry"],
      });
    }
  }

  private deliveryKey(deliveryId: string): string {
    return `linear-comment-delivery:${deliveryId}`;
  }

  private commentKey(commentId: string): string {
    return `linear-comment-id:${commentId}`;
  }

  private findResumeState({
    deliveryKey,
    commentKey,
    incomingFingerprint,
    payload,
    deliveryId,
    commentId,
    linearIssueId,
    matchedTaskIds,
  }: {
    deliveryKey: string | null;
    commentKey: string | null;
    incomingFingerprint: string;
    payload: LinearCommentPayload;
    deliveryId: string | null;
    commentId: string | null;
    linearIssueId: string | null;
    matchedTaskIds: string[];
  }): { duplicateReceipt: LinearWebhookReceipt | null; partialState: LinearWebhookDedupeState | null } {
    let partialState: LinearWebhookDedupeState | null = null;
    const deliveryDuplicate = deliveryKey ? this.taskQueue.getIdempotencyEntry(deliveryKey) : null;
    if (deliveryDuplicate) {
      this.assertDuplicateFingerprint(deliveryDuplicate, incomingFingerprint, "delivery");
      const state = this.dedupeStateOrNull(deliveryDuplicate.response);
      if (state && !state.complete) {
        partialState = state;
      } else {
        return {
          duplicateReceipt: this.createReceipt({
            payload,
            deliveryId,
            commentId,
            linearIssueId,
            matchedTasks: matchedTaskIds,
            eventIds: [],
            recorded: false,
            deduplicated: true,
            ignoredReason: "duplicate_delivery",
          }),
          partialState: null,
        };
      }
    }

    const commentDuplicate = commentKey ? this.taskQueue.getIdempotencyEntry(commentKey) : null;
    if (commentDuplicate) {
      this.assertDuplicateFingerprint(commentDuplicate, incomingFingerprint, "comment");
      const state = this.dedupeStateOrNull(commentDuplicate.response);
      if (state && !state.complete) {
        partialState = this.mergePartialStates(partialState, state);
      } else {
        return {
          duplicateReceipt: this.createReceipt({
            payload,
            deliveryId,
            commentId,
            linearIssueId,
            matchedTasks: matchedTaskIds,
            eventIds: [],
            recorded: false,
            deduplicated: true,
            ignoredReason: "duplicate_comment",
          }),
          partialState: null,
        };
      }
    }

    return { duplicateReceipt: null, partialState };
  }

  private dedupeStateOrNull(value: unknown): LinearWebhookDedupeState | null {
    if (!isRecord(value) || value.kind !== "linear-comment-webhook-dedupe") {
      return null;
    }
    if (!Array.isArray(value.processedTaskIds) || !Array.isArray(value.eventIds) || typeof value.complete !== "boolean") {
      return null;
    }
    return {
      kind: "linear-comment-webhook-dedupe",
      receipt: value.receipt as LinearWebhookReceipt,
      processedTaskIds: value.processedTaskIds.filter((id): id is string => typeof id === "string"),
      eventIds: value.eventIds.filter((id): id is string => typeof id === "string"),
      complete: value.complete,
    };
  }

  private mergePartialStates(
    current: LinearWebhookDedupeState | null,
    next: LinearWebhookDedupeState,
  ): LinearWebhookDedupeState {
    if (!current) {
      return next;
    }
    return {
      ...next,
      processedTaskIds: [...new Set([...current.processedTaskIds, ...next.processedTaskIds])],
      eventIds: [...new Set([...current.eventIds, ...next.eventIds])],
    };
  }

  private storeDedupeState({
    deliveryKey,
    commentKey,
    incomingFingerprint,
    state,
  }: {
    deliveryKey: string | null;
    commentKey: string | null;
    incomingFingerprint: string;
    state: LinearWebhookDedupeState;
  }): void {
    for (const key of [deliveryKey, commentKey]) {
      if (!key) continue;
      this.taskQueue.setIdempotencyEntry(key, {
        fingerprint: incomingFingerprint,
        response: state,
      });
    }
  }

  private assertDuplicateFingerprint(
    entry: { fingerprint: string; response: unknown },
    incomingFingerprint: string,
    duplicateKey: "delivery" | "comment"
  ): void {
    if (entry.fingerprint === incomingFingerprint) return;

    throw new TaskLifecycleError(409, "conflict", `Linear webhook ${duplicateKey} id has already been used with a different payload.`, {
      duplicateKey,
      availableActions: ["contact_support"],
    });
  }

  private createReceipt({
    payload,
    deliveryId,
    commentId,
    linearIssueId,
    matchedTasks,
    eventIds,
    recorded,
    deduplicated,
    ignoredReason,
  }: {
    payload: LinearCommentPayload;
    deliveryId: string | null;
    commentId: string | null;
    linearIssueId: string | null;
    matchedTasks: string[];
    eventIds: string[];
    recorded: boolean;
    deduplicated: boolean;
    ignoredReason: string | null;
  }): LinearWebhookReceipt {
    return {
      data: {
        accepted: true,
        provider: "linear",
        eventType: payload.type,
        action: payload.action,
        deliveryId,
        commentId,
        linearIssueId,
        matchedTasks,
        eventIds,
        recorded,
        deduplicated,
        ignored: !recorded,
        ignoredReason,
      },
      availableActions: [],
    };
  }
}

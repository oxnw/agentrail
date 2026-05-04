import { parseErrorResponse, RateLimitError } from "./errors.js";
import type {
  AgentApiKeyCreateRequest,
  AgentApiKeyResponse,
  AgentApiKeyRotateRequest,
  AgentApiKeyUsageResponse,
  AgentRailClientOptions,
  ListMyTasksOptions,
  RetryOptions,
  StreamOptions,
  TaskCiStatusResponse,
  TaskDetailResponse,
  TaskLifecycleEvent,
  TaskListResponse,
  TaskReviewFeedbackResponse,
  TaskShipRequest,
  TaskShipResponse,
  TaskSubmissionResponse,
  TaskSubmitRequest,
  TaskWebhookSubscriptionCreateRequest,
  TaskWebhookSubscriptionListResponse,
  TaskWebhookSubscriptionResponse,
} from "./types.js";

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

export class AgentRailClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly retry: Required<RetryOptions>;

  constructor(options: AgentRailClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  // ── Agent Auth ─────────────────────────────────────────────────

  async createApiKey(
    request: AgentApiKeyCreateRequest,
    idempotencyKey: string,
  ): Promise<AgentApiKeyResponse> {
    return this.request("POST", "/agent-api-keys", {
      body: request,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  async rotateApiKey(
    keyId: string,
    request?: AgentApiKeyRotateRequest,
    idempotencyKey?: string,
  ): Promise<AgentApiKeyResponse> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return this.request("POST", `/agent-api-keys/${encodeURIComponent(keyId)}/rotate`, {
      body: request,
      headers,
    });
  }

  async getApiKeyUsage(keyId: string): Promise<AgentApiKeyUsageResponse> {
    return this.request("GET", `/agent-api-keys/${encodeURIComponent(keyId)}/usage`);
  }

  // ── Tasks ──────────────────────────────────────────────────────

  async listMyTasks(options?: ListMyTasksOptions): Promise<TaskListResponse> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.request("GET", `/tasks/mine${qs ? `?${qs}` : ""}`);
  }

  async getTask(taskId: string): Promise<TaskDetailResponse> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async submitTask(
    taskId: string,
    request: TaskSubmitRequest,
    idempotencyKey: string,
  ): Promise<TaskSubmissionResponse> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/submit`, {
      body: request,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  async getTaskCiStatus(taskId: string): Promise<TaskCiStatusResponse> {
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/ci-status`);
  }

  async getTaskReviewFeedback(
    taskId: string,
  ): Promise<TaskReviewFeedbackResponse> {
    return this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/review-feedback`,
    );
  }

  async shipTask(
    taskId: string,
    request: TaskShipRequest,
    idempotencyKey: string,
  ): Promise<TaskShipResponse> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/ship`, {
      body: request,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  // ── Webhooks ───────────────────────────────────────────────────

  async listWebhookSubscriptions(): Promise<TaskWebhookSubscriptionListResponse> {
    return this.request("GET", "/task-webhook-subscriptions");
  }

  async getWebhookSubscription(
    subscriptionId: string,
  ): Promise<TaskWebhookSubscriptionResponse> {
    return this.request(
      "GET",
      `/task-webhook-subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  }

  async createWebhookSubscription(
    request: TaskWebhookSubscriptionCreateRequest,
    idempotencyKey: string,
  ): Promise<TaskWebhookSubscriptionResponse> {
    return this.request("POST", "/task-webhook-subscriptions", {
      body: request,
      headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  async deactivateWebhookSubscription(
    subscriptionId: string,
  ): Promise<TaskWebhookSubscriptionResponse> {
    return this.request(
      "DELETE",
      `/task-webhook-subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  }

  // ── Event Stream ───────────────────────────────────────────────

  async *streamEvents(
    options?: StreamOptions,
  ): AsyncGenerator<TaskLifecycleEvent, void, undefined> {
    const params = new URLSearchParams();
    if (options?.eventTypes?.length)
      params.set("eventTypes", options.eventTypes.join(","));
    if (options?.taskId) params.set("taskId", options.taskId);
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.heartbeatSeconds != null)
      params.set("heartbeatSeconds", String(options.heartbeatSeconds));
    const qs = params.toString();
    const url = `${this.baseUrl}/task-events/stream${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
    };
    if (options?.cursor) headers["Last-Event-ID"] = options.cursor;

    const res = await fetch(url, { headers, signal: options?.signal });
    if (!res.ok) {
      const body = (await res.json()) as { error: import("./types.js").ErrorDetail };
      throw parseErrorResponse(res.status, body, res.headers);
    }
    if (!res.body) throw new Error("No response body for SSE stream");

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop()!;

        for (const block of blocks) {
          if (!block.trim()) continue;
          let dataLine: string | undefined;
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              dataLine = line.slice(6);
            }
          }
          if (dataLine) {
            yield JSON.parse(dataLine) as TaskLifecycleEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...options?.headers,
    };
    if (options?.body) headers["Content-Type"] = "application/json";

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      const res = await fetch(url, {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      if (res.ok) {
        return (await res.json()) as T;
      }

      const body = (await res.json().catch(() => ({
        error: {
          code: "unknown",
          message: `HTTP ${res.status}`,
          details: {},
        },
      }))) as { error: import("./types.js").ErrorDetail };

      const err = parseErrorResponse(res.status, body, res.headers);

      if (
        !err.retryable ||
        !this.retry.retryableStatusCodes.includes(res.status) ||
        attempt === this.retry.maxAttempts
      ) {
        throw err;
      }

      lastError = err;
      const baseDelay =
        err instanceof RateLimitError && err.retryAfterSeconds
          ? err.retryAfterSeconds * 1000
          : this.retry.initialDelayMs * Math.pow(2, attempt - 1);
      const delay = Math.min(baseDelay, this.retry.maxDelayMs);
      await sleep(delay);
    }

    throw lastError ?? new Error("Retry loop exhausted");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

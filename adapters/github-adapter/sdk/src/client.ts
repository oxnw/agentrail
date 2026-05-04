import {
  ClientConfig,
  TaskListResponse,
  TaskDetailResponse,
  SubmitRequest,
  SubmitResult,
  ShipResult,
  ShipBlockedResult,
  ReviewFeedbackResponse,
  WebhookRegistration,
  WebhookEvent,
  ErrorResponse,
} from "./types";
import { AgentRailError, NetworkError, TimeoutError, isRetryable } from "./errors";

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

export class AgentRailClient {
  private baseUrl: string;
  private token: string;
  private retries: number;
  private retryDelayMs: number;
  private timeoutMs: number;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        };

        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (res.ok) {
          return await res.json() as T;
        }

        if (isRetryable(res.status) && attempt < this.retries) {
          lastError = new AgentRailError(res.status, await res.json() as ErrorResponse);
          continue;
        }

        const errorBody = await res.json().catch(() => ({
          error: res.statusText,
          code: "unknown",
          availableActions: [],
        })) as ErrorResponse;

        throw new AgentRailError(res.status, errorBody);
      } catch (err) {
        if (err instanceof AgentRailError) throw err;

        if (err instanceof DOMException && err.name === "AbortError") {
          throw new TimeoutError(url, this.timeoutMs);
        }

        lastError = err;
        if (attempt < this.retries) continue;

        throw new NetworkError(`Request to ${url} failed`, err);
      }
    }

    throw lastError;
  }

  async listTasks(assignee: string, options?: { cursor?: string; perPage?: number }): Promise<TaskListResponse> {
    const params = new URLSearchParams({ assignee });
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.perPage) params.set("per_page", String(options.perPage));
    return this.request<TaskListResponse>("GET", `/tasks/mine?${params}`);
  }

  async getTask(taskId: string): Promise<TaskDetailResponse> {
    return this.request<TaskDetailResponse>("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  async submitTask(taskId: string, req: SubmitRequest): Promise<SubmitResult> {
    return this.request<SubmitResult>("POST", `/tasks/${encodeURIComponent(taskId)}/submit`, req);
  }

  async shipTask(
    taskId: string,
    prNumber: number,
    mergeMethod?: "merge" | "squash" | "rebase"
  ): Promise<ShipResult | ShipBlockedResult> {
    return this.request<ShipResult | ShipBlockedResult>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/ship`,
      { prNumber, mergeMethod: mergeMethod ?? "squash" }
    );
  }

  async getReviewFeedback(taskId: string, prNumber: number): Promise<ReviewFeedbackResponse> {
    return this.request<ReviewFeedbackResponse>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/review-feedback?pr=${prNumber}`
    );
  }

  async registerWebhook(url: string, events: WebhookEvent[]): Promise<WebhookRegistration> {
    return this.request<WebhookRegistration>("POST", "/webhooks", { url, events });
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    return this.request<WebhookRegistration[]>("GET", "/webhooks");
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<void>("DELETE", `/webhooks/${webhookId}`);
  }

  async *paginateTasks(assignee: string, perPage = 20): AsyncGenerator<TaskListResponse> {
    let cursor: string | undefined;
    do {
      const page = await this.listTasks(assignee, { cursor, perPage });
      yield page;
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
}

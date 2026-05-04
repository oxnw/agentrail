import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentAuthStore } from "./agent-auth-store.js";
import { AgentAuthError } from "./agent-auth-store.js";
import { CiStatusSourceError } from "./github-actions-ci-adapter.js";
import { ReviewFeedbackSourceError } from "./github-review-feedback-adapter.js";
import { RollbackSourceError } from "./github-rollback-adapter.js";
import { TaskLifecycleError } from "./task-lifecycle-errors.js";
import { CursorExpiredError, matchesFilters, TaskEventStore } from "./task-event-store.js";
import {
  ConflictError,
  TaskWebhookSubscriptionStore,
  ValidationError
} from "./task-webhook-store.js";
import { WaitlistStore, WaitlistValidationError } from "./waitlist-store.js";
import { createOperationTimer } from "./structured-logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HEARTBEAT_SECONDS = 20;
const MIN_HEARTBEAT_SECONDS = 10;
const MAX_HEARTBEAT_SECONDS = 60;

export interface CreateServerOptions {
  store: TaskEventStore;
  now?: () => Date;
  ciStatusAdapter?: { getTaskCiStatus?(taskId: string): Promise<unknown> | unknown; receiveWebhook?(payload: { headers: Record<string, string | string[]>; rawBody: string }): Promise<unknown> } | null;
  reviewFeedbackAdapter?: { getTaskReviewFeedback?(taskId: string): Promise<unknown> | unknown } | null;
  rollbackAdapter?: { rollbackTask?(taskId: string, payload: unknown, idempotencyKey: string): Promise<unknown> } | null;
  authStore?: AgentAuthStore | null;
  taskLifecycleStore?: unknown;
  waitlistStore?: WaitlistStore | null;
  publicBaseUrl?: string | null;
  fallbackMode?: boolean;
  emailWebhookUrl?: string | null;
  emailWebhookToken?: string | null;
  resendApiKey?: string | null;
  resendFromEmail?: string;
  sendgridApiKey?: string | null;
  sendgridFromEmail?: string;
  brevoApiKey?: string | null;
  brevoFromEmail?: string;
  brevoFromName?: string;
}

export function createServer({
  store,
  now = () => new Date(),
  ciStatusAdapter = null,
  reviewFeedbackAdapter = null,
  rollbackAdapter = null,
  authStore = null,
  taskLifecycleStore = null,
  waitlistStore = null,
  publicBaseUrl = process.env.AGENTRAIL_PUBLIC_BASE_URL || null,
  fallbackMode = false,
  emailWebhookUrl = process.env.WAITLIST_EMAIL_WEBHOOK_URL || null,
  emailWebhookToken = process.env.WAITLIST_EMAIL_WEBHOOK_TOKEN || null,
  resendApiKey = process.env.RESEND_API_KEY || null,
  resendFromEmail = process.env.RESEND_FROM_EMAIL || "AgentRail <waitlist@agentrail.app>",
  sendgridApiKey = process.env.SENDGRID_API_KEY || null,
  sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || "AgentRail <waitlist@agentrail.app>",
  brevoApiKey = process.env.BREVO_API_KEY || null,
  brevoFromEmail = process.env.BREVO_FROM_EMAIL || "waitlist@agentrail.app",
  brevoFromName = process.env.BREVO_FROM_NAME || "AgentRail"
}: CreateServerOptions) {
  const webhookStore = new TaskWebhookSubscriptionStore({ now });
  const resolvedWaitlistStore = waitlistStore ?? new WaitlistStore({ now });

  return http.createServer((request, response) => {
    void routeRequest({
      request,
      response,
      store,
      webhookStore,
      now,
      ciStatusAdapter,
      reviewFeedbackAdapter,
      rollbackAdapter,
      authStore,
      taskLifecycleStore,
      waitlistStore: resolvedWaitlistStore,
      publicBaseUrl,
      fallbackMode,
      emailWebhookUrl,
      emailWebhookToken,
      resendApiKey,
      resendFromEmail,
      sendgridApiKey,
      sendgridFromEmail,
      brevoApiKey,
      brevoFromEmail,
      brevoFromName
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, {
        "content-type": "application/json"
      });
      response.end(
        JSON.stringify({
          error: {
            code: "internal_error",
            message,
            details: {}
          }
        })
      );
    });
  });
}

interface RouteRequestOptions extends CreateServerOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  webhookStore: TaskWebhookSubscriptionStore;
}

async function routeRequest({
  request,
  response,
  store,
  webhookStore,
  now,
  ciStatusAdapter,
  reviewFeedbackAdapter,
  rollbackAdapter,
  authStore,
  taskLifecycleStore,
  waitlistStore,
  publicBaseUrl = null,
  fallbackMode = false,
  emailWebhookUrl = null,
  emailWebhookToken = null,
  resendApiKey = null,
  resendFromEmail = "AgentRail <waitlist@agentrail.app>",
  sendgridApiKey = null,
  sendgridFromEmail = "AgentRail <waitlist@agentrail.app>",
  brevoApiKey = null,
  brevoFromEmail = "waitlist@agentrail.app",
  brevoFromName = "AgentRail"
}: RouteRequestOptions) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const routePrefix = resolveRoutePrefix(publicBaseUrl);
  const pathname = stripRoutePrefix(url.pathname, routePrefix);

  // Observability: intercept writeHead/end to capture status + emit log entry.
  const obs: { operation: string | null; agentId: string | null; taskId: string | null; idempotencyKey: string | null; provider?: string } = { operation: null, agentId: null, taskId: null, idempotencyKey: request.headers["idempotency-key"] as string ?? null };
  const timer = createOperationTimer(obs);
  let capturedStatus: number | null = null;
  const origWriteHead = response.writeHead.bind(response);
  response.writeHead = (statusCode: number, ...rest: unknown[]) => {
    capturedStatus = statusCode;
    return origWriteHead(statusCode, ...(rest as [http.OutgoingHttpHeaders | string, http.OutgoingHttpHeaders | undefined]));
  };
  const origEnd = response.end.bind(response);
  response.end = (body: unknown, ...rest: unknown[]) => {
    const result = origEnd(body, ...rest);
    const estimatedTokens = typeof body === "string" ? Math.ceil(body.length / 4) : null;
    const logFields = { ...obs, statusCode: capturedStatus, estimatedTokens };
    if (capturedStatus != null && capturedStatus >= 400) {
      timer.error(logFields);
    } else {
      timer.finish(logFields);
    }
    return result;
  };

  // Fallback switch: return 503 on all task lifecycle routes so agents can detect
  // the condition and revert to direct GitHub / Paperclip APIs.
  const isTaskRoute = /^\/(tasks|task-events|task-webhook-subscriptions|agent-api-keys)/.test(pathname);
  if (fallbackMode && isTaskRoute) {
    obs.operation = obs.operation ?? "fallback_gate";
    response.writeHead(503, {
      "content-type": "application/json",
      "x-agentrail-fallback": "true"
    });
    response.end(JSON.stringify({
      error: {
        code: "fallback_mode",
        message: "AgentRail is in fallback mode. Use direct provider APIs for this operation.",
        details: {
          fallback: true,
          availableActions: ["use_direct_github_api", "use_direct_paperclip_api"]
        }
      }
    }));
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    serveStaticFile(response, path.join(__dirname, "..", "landing", "index-light.html"), "text/html");
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(buildHealthResponse({
      request,
      now: now ?? (() => new Date()),
      publicBaseUrl,
      routePrefix
    })));
    return;
  }

  if (request.method === "GET" && pathname === "/demo.mp4") {
    serveStaticFile(response, path.join(__dirname, "..", "docs", "demo", "agentrail-e2e-demo.mp4"), "video/mp4");
    return;
  }

  if (request.method === "POST" && pathname === "/waitlist") {
    obs.operation = "waitlist_signup";
    await handleWaitlistSignup({ request, response, waitlistStore: waitlistStore as WaitlistStore, emailWebhookUrl, emailWebhookToken, resendApiKey, resendFromEmail, sendgridApiKey, sendgridFromEmail, brevoApiKey, brevoFromEmail, brevoFromName });
    return;
  }

  if (request.method === "OPTIONS" && pathname === "/waitlist") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, idempotency-key"
    });
    response.end();
    return;
  }

  if (request.method === "POST" && pathname === "/agent-api-keys") {
    if (!ensureAuthStore({ response, authStore })) {
      return;
    }

    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "auth:admin",
      operation: "create_agent_api_key",
      allowBootstrap: true
    });
    if (principal === false) {
      return;
    }

    await handleCreateAgentApiKey({ request, response, authStore, principal });
    return;
  }

  const rotateKeyMatch =
    request.method === "POST"
      ? pathname.match(/^\/agent-api-keys\/(akey_[A-Za-z0-9]+)\/rotate$/)
      : null;
  if (rotateKeyMatch) {
    if (!ensureAuthStore({ response, authStore })) {
      return;
    }

    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "auth:admin",
      operation: "rotate_agent_api_key"
    });
    if (principal === false) {
      return;
    }

    await handleRotateAgentApiKey({
      request,
      response,
      authStore,
      keyId: rotateKeyMatch[1]
    });
    return;
  }

  const usageMatch =
    request.method === "GET"
      ? pathname.match(/^\/agent-api-keys\/(akey_[A-Za-z0-9]+)\/usage$/)
      : null;
  if (usageMatch) {
    if (!ensureAuthStore({ response, authStore })) {
      return;
    }

    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "usage:read",
      operation: "get_agent_api_key_usage"
    });
    if (principal === false) {
      return;
    }

    handleGetAgentApiKeyUsage({
      response,
      authStore,
      keyId: usageMatch[1]
    });
    return;
  }

  if (request.method === "GET" && pathname === "/tasks/mine") {
    obs.operation = "list_my_tasks";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:read",
      operation: "list_my_tasks"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleListMyTasks({ response, url, taskLifecycleStore, principal });
    return;
  }

  const taskDetailMatch =
    request.method === "GET" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)$/) : null;
  if (taskDetailMatch) {
    obs.operation = "get_task";
    obs.taskId = taskDetailMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:read",
      operation: "get_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleGetTask({
      response,
      taskLifecycleStore,
      taskId: taskDetailMatch[1]
    });
    return;
  }

  const submitMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/submit$/) : null;
  if (submitMatch) {
    obs.operation = "submit_task";
    obs.taskId = submitMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "submit_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleSubmitTask({
      request,
      response,
      taskLifecycleStore,
      taskId: submitMatch[1]
    });
    return;
  }

  if (request.method === "GET" && pathname === "/task-events/stream") {
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "events:read",
      operation: "stream_task_events"
    });
    if (principal === false) {
      return;
    }

    handleTaskEventStream({ request, response, url, store, now });
    return;
  }

  if (request.method === "GET" && pathname === "/task-webhook-subscriptions") {
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:read",
      operation: "list_task_webhook_subscriptions"
    });
    if (principal === false) {
      return;
    }

    handleListTaskWebhookSubscriptions({ response, webhookStore });
    return;
  }

  if (request.method === "POST" && pathname === "/task-webhook-subscriptions") {
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:write",
      operation: "create_task_webhook_subscription"
    });
    if (principal === false) {
      return;
    }

    await handleCreateTaskWebhookSubscription({ request, response, webhookStore });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/circleci/webhooks") {
    await handleCircleCiWebhook({ request, response, ciStatusAdapter });
    return;
  }

  const ciStatusMatch =
    request.method === "GET" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/ci-status$/) : null;
  if (ciStatusMatch) {
    obs.operation = "get_task_ci_status";
    obs.taskId = ciStatusMatch[1];
    obs.provider = "github_actions";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "ci:read",
      operation: "get_task_ci_status"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleGetTaskCiStatus({
      response,
      ciStatusAdapter,
      taskId: ciStatusMatch[1]
    });
    return;
  }

  const reviewFeedbackMatch =
    request.method === "GET" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/review-feedback$/) : null;
  if (reviewFeedbackMatch) {
    obs.operation = "get_task_review_feedback";
    obs.taskId = reviewFeedbackMatch[1];
    obs.provider = "github";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "reviews:read",
      operation: "get_task_review_feedback"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleGetTaskReviewFeedback({
      response,
      reviewFeedbackAdapter,
      taskId: reviewFeedbackMatch[1]
    });
    return;
  }

  const shipMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/ship$/) : null;
  if (shipMatch) {
    obs.operation = "ship_task";
    obs.taskId = shipMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "ship:write",
      operation: "ship_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleShipTask({
      request,
      response,
      taskLifecycleStore,
      taskId: shipMatch[1]
    });
    return;
  }

  const rollbackMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/rollback$/) : null;
  if (rollbackMatch) {
    obs.operation = "rollback_task";
    obs.taskId = rollbackMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "ship:write",
      operation: "rollback_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleRollbackTask({
      request,
      response,
      taskLifecycleStore,
      rollbackAdapter,
      taskId: rollbackMatch[1]
    });
    return;
  }

  const getWebhookSubscriptionMatch =
    request.method === "GET"
      ? pathname.match(/^\/task-webhook-subscriptions\/(whsub_[A-Za-z0-9]+)$/)
      : null;
  if (getWebhookSubscriptionMatch) {
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:read",
      operation: "get_task_webhook_subscription"
    });
    if (principal === false) {
      return;
    }

    handleGetTaskWebhookSubscription({
      response,
      webhookStore,
      subscriptionId: getWebhookSubscriptionMatch[1]
    });
    return;
  }

  const deleteMatch =
    request.method === "DELETE"
      ? pathname.match(/^\/task-webhook-subscriptions\/(whsub_[A-Za-z0-9]+)$/)
      : null;
  if (deleteMatch) {
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:write",
      operation: "deactivate_task_webhook_subscription"
    });
    if (principal === false) {
      return;
    }

    handleDeactivateTaskWebhookSubscription({
      response,
      webhookStore,
      subscriptionId: deleteMatch[1]
    });
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify({ error: { code: "not_found", message: "Not found", details: {} } }));
}

interface PrincipalLike {
  agent?: { id?: string } | null;
  keyId?: string;
}

interface ListMyTasksOptions {
  response: http.ServerResponse;
  url: URL;
  taskLifecycleStore: unknown;
  principal?: PrincipalLike | null;
}

async function handleListMyTasks({ response, url, taskLifecycleStore, principal }: ListMyTasksOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { listMyTasks?: unknown }).listMyTasks !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: []
    });
    return;
  }

  try {
    const store = taskLifecycleStore as { listMyTasks: (opts: Record<string, unknown>) => Promise<unknown> | unknown };
    const opts: Record<string, unknown> = {
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    };
    if (principal != null) {
      // Pass user context for identity-aware task stores (e.g. GitHub assignee resolution)
      opts.principal = principal;
    }
    const body = await store.listMyTasks(opts);
    writeJson(response, 200, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface GetTaskOptions {
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  taskId: string;
}

async function handleGetTask({ response, taskLifecycleStore, taskId }: GetTaskOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { getTask?: unknown }).getTask !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const body = await (taskLifecycleStore as { getTask: (id: string) => Promise<unknown> | unknown }).getTask(taskId);
    writeJson(response, 200, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface CreateKeyOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  authStore: AgentAuthStore;
  principal: ReturnType<AgentAuthStore["authenticate"]> | false | null;
}

async function handleCreateAgentApiKey({ request, response, authStore, principal }: CreateKeyOptions) {
  try {
    const payload = await readJsonBody(request);
    if (!principal && !(payload as { scopes?: string[] }).scopes?.includes("auth:admin")) {
      writeError(response, 400, "validation_error", "Bootstrap key must include `auth:admin`.", {
        availableActions: ["retry"]
      });
      return;
    }

    const body = authStore.createKey(payload as Parameters<AgentAuthStore["createKey"]>[0], request.headers["idempotency-key"] as string);
    response.writeHead(201, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(body));
  } catch (error) {
    if (error instanceof AgentAuthError) {
      writeError(response, error.statusCode, error.code, error.message, error.details, error.headers);
      return;
    }

    throw error;
  }
}

interface RotateKeyOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  authStore: AgentAuthStore;
  keyId: string;
}

async function handleRotateAgentApiKey({ request, response, authStore, keyId }: RotateKeyOptions) {
  try {
    const payload = await readJsonBody(request);
    const body = authStore.rotateKey(keyId, payload as Parameters<AgentAuthStore["rotateKey"]>[1], request.headers["idempotency-key"] as string);
    response.writeHead(201, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(body));
  } catch (error) {
    if (error instanceof AgentAuthError) {
      writeError(response, error.statusCode, error.code, error.message, error.details, error.headers);
      return;
    }

    throw error;
  }
}

interface GetUsageOptions {
  response: http.ServerResponse;
  authStore: AgentAuthStore;
  keyId: string;
}

function handleGetAgentApiKeyUsage({ response, authStore, keyId }: GetUsageOptions) {
  try {
    const body = authStore.getUsage(keyId);
    response.writeHead(200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(body));
  } catch (error) {
    if (error instanceof AgentAuthError) {
      writeError(response, error.statusCode, error.code, error.message, error.details, error.headers);
      return;
    }

    throw error;
  }
}

interface SubmitTaskOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  taskId: string;
}

async function handleSubmitTask({ request, response, taskLifecycleStore, taskId }: SubmitTaskOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { submitTask?: unknown }).submitTask !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await (taskLifecycleStore as { submitTask: (taskId: string, payload: unknown, key: string | undefined) => Promise<unknown> }).submitTask(
      taskId,
      payload,
      request.headers["idempotency-key"] as string | undefined
    );
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface GetCiStatusOptions {
  response: http.ServerResponse;
  ciStatusAdapter: { getTaskCiStatus?(taskId: string): Promise<unknown> | unknown } | null;
  taskId: string;
}

async function handleGetTaskCiStatus({ response, ciStatusAdapter, taskId }: GetCiStatusOptions) {
  let body: unknown = null;
  try {
    body = ciStatusAdapter && typeof ciStatusAdapter.getTaskCiStatus === "function"
      ? await ciStatusAdapter.getTaskCiStatus(taskId)
      : null;
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    if (error instanceof CiStatusSourceError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }

  if (!body) {
    writeError(response, 404, "not_found", "CI source not found for task.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

interface CircleCiWebhookOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  ciStatusAdapter: { receiveWebhook?(payload: { headers: Record<string, string | string[]>; rawBody: string }): Promise<unknown> } | null;
}

async function handleCircleCiWebhook({ request, response, ciStatusAdapter }: CircleCiWebhookOptions) {
  if (!ciStatusAdapter || typeof ciStatusAdapter.receiveWebhook !== "function") {
    writeError(response, 404, "not_found", "CircleCI webhook source not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const rawBody = await readRequestBody(request);
    const body = await ciStatusAdapter.receiveWebhook({
      headers: request.headers as Record<string, string | string[]>,
      rawBody
    });
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeError(response, 400, "validation_error", "Request body must be valid JSON.", {
        availableActions: ["retry"]
      });
      return;
    }

    if (error instanceof CiStatusSourceError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface GetReviewFeedbackOptions {
  response: http.ServerResponse;
  reviewFeedbackAdapter: { getTaskReviewFeedback?(taskId: string): Promise<unknown> | unknown } | null;
  taskId: string;
}

async function handleGetTaskReviewFeedback({ response, reviewFeedbackAdapter, taskId }: GetReviewFeedbackOptions) {
  let body: unknown = null;
  try {
    body = reviewFeedbackAdapter && typeof reviewFeedbackAdapter.getTaskReviewFeedback === "function"
      ? await reviewFeedbackAdapter.getTaskReviewFeedback(taskId)
      : null;
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    if (error instanceof ReviewFeedbackSourceError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }

  if (!body) {
    writeError(response, 404, "not_found", "Review feedback source not found for task.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

interface ShipTaskOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  taskId: string;
}

async function handleShipTask({ request, response, taskLifecycleStore, taskId }: ShipTaskOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { shipTask?: unknown }).shipTask !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await (taskLifecycleStore as { shipTask: (taskId: string, payload: unknown, key: string | undefined) => Promise<unknown> }).shipTask(
      taskId,
      payload,
      request.headers["idempotency-key"] as string | undefined
    );
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface RollbackTaskOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  rollbackAdapter: { rollbackTask?(taskId: string, payload: unknown, idempotencyKey: string): Promise<unknown> } | null;
  taskId: string;
}

async function handleRollbackTask({ request, response, taskLifecycleStore, rollbackAdapter, taskId }: RollbackTaskOptions) {
  if (!taskLifecycleStore && !rollbackAdapter) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);

    let body: unknown;
    if (rollbackAdapter && typeof rollbackAdapter.rollbackTask === "function") {
      body = await rollbackAdapter.rollbackTask(
        taskId,
        payload,
        request.headers["idempotency-key"] as string
      );
    } else {
      body = await (taskLifecycleStore as { rollbackTask: (taskId: string, payload: unknown, key: string | undefined) => Promise<unknown> }).rollbackTask(
        taskId,
        payload,
        request.headers["idempotency-key"] as string | undefined
      );
    }
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    if (error instanceof RollbackSourceError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

interface TaskEventStreamOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  store: TaskEventStore;
  now: () => Date;
}

function handleTaskEventStream({ request, response, url, store, now }: TaskEventStreamOptions) {
  const heartbeatSeconds = clampHeartbeatSeconds(url.searchParams.get("heartbeatSeconds"));
  const filters = {
    taskId: url.searchParams.get("taskId") ?? undefined,
    eventTypes: parseEventTypes(url.searchParams.get("eventTypes"))
  };

  let replayEvents: Array<{ sequence: number; id: string; type: string }> = [];
  let lastSentSequence = store.getMaxSequence();
  let resumeMode = "live";

  const resumeCursor = request.headers["last-event-id"] ?? url.searchParams.get("cursor");

  try {
    if (resumeCursor) {
      const referenceEvent = store.resolveCursor(resumeCursor as string);
      replayEvents = store.getEventsAfter(referenceEvent.sequence, filters);
      lastSentSequence = referenceEvent.sequence;
      resumeMode = "replay_then_live";
    }
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      response.writeHead(410, {
        "content-type": "application/json"
      });
      response.end(
        JSON.stringify({
          error: {
            code: "cursor_expired",
            message: "The requested stream cursor is no longer available.",
            details: {
              replayWindowHours: store.replayWindowHours,
              availableActions: ["reconnect_without_cursor"]
            }
          }
        })
      );
      return;
    }

    throw error;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-agentrail-replay-window-hours": String(store.replayWindowHours),
    "x-agentrail-stream-heartbeat-seconds": String(heartbeatSeconds),
    "x-agentrail-resume-mode": resumeMode
  });
  response.write("retry: 5000\n\n");

  const sendEvent = (event: { sequence: number; id: string; type: string }) => {
    if (event.sequence <= lastSentSequence || !matchesFilters(event as unknown as Parameters<typeof matchesFilters>[0], filters)) {
      return;
    }

    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    lastSentSequence = event.sequence;
  };

  for (const event of replayEvents) {
    sendEvent(event);
  }

  const unsubscribe = store.subscribe((event) => {
    sendEvent(event);
  });

  const keepalive = setInterval(() => {
    response.write(`: keepalive ${now().toISOString()}\n\n`);
  }, heartbeatSeconds * 1000);

  request.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}

function clampHeartbeatSeconds(rawValue: string | null) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_HEARTBEAT_SECONDS;
  }

  return Math.min(MAX_HEARTBEAT_SECONDS, Math.max(MIN_HEARTBEAT_SECONDS, parsed));
}

function parseEventTypes(rawValue: string | null): Set<string> | undefined {
  if (!rawValue) {
    return undefined;
  }

  return new Set(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function buildHealthResponse({
  request,
  now,
  publicBaseUrl,
  routePrefix
}: {
  request: http.IncomingMessage;
  now: () => Date;
  publicBaseUrl: string | null;
  routePrefix: string;
}) {
  return {
    status: "ok",
    service: "agentrail-service",
    publicBaseUrl: publicBaseUrl || inferRequestBaseUrl(request),
    pathPrefix: routePrefix || null,
    time: now().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  };
}

function resolveRoutePrefix(publicBaseUrl: string | null): string {
  if (!publicBaseUrl) {
    return "";
  }

  try {
    const { pathname } = new URL(publicBaseUrl);
    if (!pathname || pathname === "/") {
      return "";
    }

    return pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function stripRoutePrefix(pathname: string, routePrefix: string): string {
  if (!routePrefix) {
    return pathname;
  }

  if (pathname === routePrefix) {
    return "/";
  }

  if (!pathname.startsWith(`${routePrefix}/`)) {
    return pathname;
  }

  const stripped = pathname.slice(routePrefix.length);
  return stripped || "/";
}

function inferRequestBaseUrl(request: http.IncomingMessage): string {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers.host || "127.0.0.1";
  return `${protocol}://${host}`;
}

function ensureAuthStore({ response, authStore }: { response: http.ServerResponse; authStore: AgentAuthStore | null | undefined }) {
  if (authStore) {
    return true;
  }

  writeError(response, 503, "auth_store_unavailable", "Agent authentication store is not configured.", {
    availableActions: ["contact_support"]
  });
  return false;
}

interface AuthorizeOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  authStore: AgentAuthStore | null | undefined;
  requiredScope: string;
  operation: string;
  allowBootstrap?: boolean;
}

function authorizeRoute({
  request,
  response,
  authStore,
  requiredScope,
  operation,
  allowBootstrap = false
}: AuthorizeOptions) {
  if (!authStore) {
    return null;
  }

  if (allowBootstrap && authStore.canBootstrap() && !request.headers.authorization) {
    return null;
  }

  try {
    return authStore.authenticate({
      authorizationHeader: request.headers.authorization,
      requiredScope,
      operation
    });
  } catch (error) {
    if (error instanceof AgentAuthError) {
      writeError(response, error.statusCode, error.code, error.message, error.details, error.headers);
      return false;
    }

    throw error;
  }
}

interface CreateWebhookOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  webhookStore: TaskWebhookSubscriptionStore;
}

async function handleCreateTaskWebhookSubscription({ request, response, webhookStore }: CreateWebhookOptions) {
  try {
    const payload = await readJsonBody(request);
    const body = webhookStore.createSubscription(payload as Parameters<TaskWebhookSubscriptionStore["createSubscription"]>[0], request.headers["idempotency-key"] as string);
    response.writeHead(201, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(body));
  } catch (error) {
    if (error instanceof ValidationError) {
      writeError(response, 400, "validation_error", error.message, error.details);
      return;
    }

    if (error instanceof ConflictError) {
      writeError(response, 409, "conflict", error.message, error.details);
      return;
    }

    throw error;
  }
}

function handleListTaskWebhookSubscriptions({ response, webhookStore }: { response: http.ServerResponse; webhookStore: TaskWebhookSubscriptionStore }) {
  const body = webhookStore.listSubscriptions();
  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function handleGetTaskWebhookSubscription({ response, webhookStore, subscriptionId }: { response: http.ServerResponse; webhookStore: TaskWebhookSubscriptionStore; subscriptionId: string }) {
  const body = webhookStore.getSubscription(subscriptionId);
  if (!body) {
    writeError(response, 404, "not_found", "Webhook subscription not found.", {});
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function handleDeactivateTaskWebhookSubscription({ response, webhookStore, subscriptionId }: { response: http.ServerResponse; webhookStore: TaskWebhookSubscriptionStore; subscriptionId: string }) {
  const body = webhookStore.deactivateSubscription(subscriptionId);
  if (!body) {
    writeError(response, 404, "not_found", "Webhook subscription not found.", {});
    return;
  }

  response.writeHead(202, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const rawBody = await readRequestBody(request);
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function writeError(response: http.ServerResponse, statusCode: number, code: string, message: string, details: Record<string, unknown>, headers: Record<string, string> = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers
  });
  response.end(
    JSON.stringify({
      error: {
        code,
        message,
        details
      }
    })
  );
}

interface WaitlistSignupOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  waitlistStore: WaitlistStore;
  emailWebhookUrl: string | null;
  emailWebhookToken: string | null;
  resendApiKey: string | null;
  resendFromEmail: string;
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
  brevoApiKey: string | null;
  brevoFromEmail: string;
  brevoFromName: string;
}

async function handleWaitlistSignup({ request, response, waitlistStore, emailWebhookUrl, emailWebhookToken, resendApiKey, resendFromEmail, sendgridApiKey, sendgridFromEmail, brevoApiKey, brevoFromEmail, brevoFromName }: WaitlistSignupOptions) {
  try {
    const payload = await readJsonBody(request);
    const result = waitlistStore.addEntry(payload as { email: string; name?: string | null; teamName?: string | null; teamSize?: number | null; agentFramework?: string | null; message?: string | null }, request.headers["idempotency-key"] as string | undefined);

    let confirmationEmail = "skipped";
    if (!result.alreadyExists) {
      if (brevoApiKey) {
        confirmationEmail = await sendBrevoConfirmation({ entry: result.entry, apiKey: brevoApiKey, fromEmail: brevoFromEmail, fromName: brevoFromName });
      }
      if (confirmationEmail !== "sent" && sendgridApiKey) {
        confirmationEmail = await sendSendGridConfirmation({ entry: result.entry, apiKey: sendgridApiKey, from: sendgridFromEmail });
      }
      if (confirmationEmail !== "sent" && resendApiKey) {
        confirmationEmail = await sendResendConfirmation({ entry: result.entry, apiKey: resendApiKey, from: resendFromEmail });
      }
      if (confirmationEmail !== "sent" && emailWebhookUrl) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (emailWebhookToken) {
          headers["authorization"] = `Bearer ${emailWebhookToken}`;
        }
        try {
          const webhookRes = await fetch(emailWebhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              email: result.entry.email,
              name: result.entry.name,
              id: result.entry.id,
              createdAt: result.entry.createdAt
            })
          });
          confirmationEmail = webhookRes.ok ? "sent" : "failed";
        } catch {
          confirmationEmail = "failed";
        }
      }
    }

    const statusCode = result.alreadyExists ? 200 : 201;
    response.writeHead(statusCode, {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    });
    response.end(JSON.stringify({
      id: result.entry.id,
      email: result.entry.email,
      alreadyExists: result.alreadyExists,
      confirmationEmail,
      message: result.alreadyExists
        ? "You're already on the waitlist! We'll be in touch."
        : "Thanks for signing up! We'll reach out soon."
    }));
  } catch (error) {
    if (error instanceof WaitlistValidationError) {
      response.writeHead(400, {
        "content-type": "application/json",
        "access-control-allow-origin": "*"
      });
      response.end(JSON.stringify({
        error: { code: error.code, message: error.message, details: {} }
      }));
      return;
    }

    throw error;
  }
}

async function sendBrevoConfirmation({ entry, apiKey, fromEmail, fromName }: { entry: { name: string | null; email: string }; apiKey: string; fromEmail: string; fromName: string }) {
  const name = entry.name ? entry.name.split(" ")[0] : "there";
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#111">
<p style="font-size:18px;font-weight:600">You're on the AgentRail waitlist.</p>
<p>Hi ${name},</p>
<p>Thanks for signing up! We'll reach out when Cloud opens — you're in line.</p>
<p>In the meantime, the OSS package is ready to use today:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px">npm install agentrail</pre>
<p style="margin-top:32px;color:#666;font-size:13px">
  — The AgentRail team<br/>
  <a href="https://github.com/oxnw/agentrail">github.com/oxnw/agentrail</a>
</p>
</body></html>`;
  const text = `You're on the AgentRail waitlist.\n\nHi ${name},\n\nThanks for signing up! We'll reach out when Cloud opens.\n\nIn the meantime: npm install agentrail\n\n— The AgentRail team`;
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: entry.email, name: entry.name || entry.email }],
        subject: "You're on the AgentRail waitlist",
        htmlContent: html,
        textContent: text
      })
    });
    if (res.ok) return "sent";
    const body = await res.text().catch(() => "");
    process.stderr.write(`[brevo] ${res.status} ${body}\n`);
    return "failed";
  } catch (err) {
    process.stderr.write(`[brevo] fetch error: ${err instanceof Error ? err.message : String(err)}\n`);
    return "failed";
  }
}

async function sendResendConfirmation({ entry, apiKey, from }: { entry: { name: string | null; email: string }; apiKey: string; from: string }) {
  const name = entry.name ? entry.name.split(" ")[0] : "there";
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#111">
<p style="font-size:18px;font-weight:600">You're on the AgentRail waitlist.</p>
<p>Hi ${name},</p>
<p>Thanks for signing up! We'll reach out when Cloud opens — you're in line.</p>
<p>In the meantime, the OSS package is ready to use today:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px">npm install agentrail</pre>
<p style="margin-top:32px;color:#666;font-size:13px">
  — The AgentRail team<br/>
  <a href="https://github.com/oxnw/agentrail">github.com/oxnw/agentrail</a>
</p>
</body></html>`;
  const text = `You're on the AgentRail waitlist.\n\nHi ${name},\n\nThanks for signing up! We'll reach out when Cloud opens.\n\nIn the meantime: npm install agentrail\n\n— The AgentRail team`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        from,
        to: [entry.email],
        subject: "You're on the AgentRail waitlist",
        html,
        text
      })
    });
    if (res.ok) return "sent";
    const body = await res.text().catch(() => "");
    process.stderr.write(`[resend] ${res.status} ${body}\n`);
    return "failed";
  } catch (err) {
    process.stderr.write(`[resend] fetch error: ${err instanceof Error ? err.message : String(err)}\n`);
    return "failed";
  }
}

async function sendSendGridConfirmation({ entry, apiKey, from }: { entry: { name: string | null; email: string }; apiKey: string; from: string }) {
  const name = entry.name ? entry.name.split(" ")[0] : "there";
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;color:#111">
<p style="font-size:18px;font-weight:600">You're on the AgentRail waitlist.</p>
<p>Hi ${name},</p>
<p>Thanks for signing up! We'll reach out when Cloud opens — you're in line.</p>
<p>In the meantime, the OSS package is ready to use today:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px">npm install agentrail</pre>
<p style="margin-top:32px;color:#666;font-size:13px">
  — The AgentRail team<br/>
  <a href="https://github.com/oxnw/agentrail">github.com/oxnw/agentrail</a>
</p>
</body></html>`;
  const text = `You're on the AgentRail waitlist.\n\nHi ${name},\n\nThanks for signing up! We'll reach out when Cloud opens.\n\nIn the meantime: npm install agentrail\n\n— The AgentRail team`;
  const fromMatch = from.match(/^([^\u003c]+)<([^\u003e]+)>$/);
  const fromField = fromMatch
    ? { name: fromMatch[1].trim(), email: fromMatch[2].trim() }
    : { email: from.trim() };
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: entry.email }] }],
        from: fromField,
        subject: "You're on the AgentRail waitlist",
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html }
        ]
      })
    });
    if (res.ok) return "sent";
    const body = await res.text().catch(() => "");
    process.stderr.write(`[sendgrid] ${res.status} ${body}\n`);
    return "failed";
  } catch (err) {
    process.stderr.write(`[sendgrid] fetch error: ${err instanceof Error ? err.message : String(err)}\n`);
    return "failed";
  }
}

function serveStaticFile(response: http.ServerResponse, filePath: string, contentType: string) {
  try {
    const content = fs.readFileSync(filePath);
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found", details: {} } }));
  }
}

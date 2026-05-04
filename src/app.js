import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentAuthError } from "./agent-auth-store.js";
import { CiStatusSourceError } from "./github-actions-ci-adapter.js";
import { ReviewFeedbackSourceError } from "./github-review-feedback-adapter.js";
import { RollbackSourceError } from "./github-rollback-adapter.js";
import { TaskLifecycleError } from "./task-lifecycle-errors.js";
import { CursorExpiredError, matchesFilters } from "./task-event-store.js";
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

export function createServer({
  store,
  now = () => new Date(),
  ciStatusAdapter = null,
  reviewFeedbackAdapter = null,
  rollbackAdapter = null,
  authStore = null,
  taskLifecycleStore = null,
  waitlistStore = null,
  fallbackMode = false,
  emailWebhookUrl = process.env.WAITLIST_EMAIL_WEBHOOK_URL || null,
  emailWebhookToken = process.env.WAITLIST_EMAIL_WEBHOOK_TOKEN || null,
  resendApiKey = process.env.RESEND_API_KEY || null,
  resendFromEmail = process.env.RESEND_FROM_EMAIL || "AgentRail <waitlist@agentrail.dev>",
  sendgridApiKey = process.env.SENDGRID_API_KEY || null,
  sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL || "AgentRail <waitlist@agentrail.dev>",
  brevoApiKey = process.env.BREVO_API_KEY || null,
  brevoFromEmail = process.env.BREVO_FROM_EMAIL || "waitlist@agentrail.dev",
  brevoFromName = process.env.BREVO_FROM_NAME || "AgentRail"
}) {
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
    }).catch((error) => {
      response.writeHead(500, {
        "content-type": "application/json"
      });
      response.end(
        JSON.stringify({
          error: {
            code: "internal_error",
            message: error.message,
            details: {}
          }
        })
      );
    });
  });
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
  fallbackMode = false,
  emailWebhookUrl = null,
  emailWebhookToken = null,
  resendApiKey = null,
  resendFromEmail = "AgentRail <waitlist@agentrail.dev>",
  sendgridApiKey = null,
  sendgridFromEmail = "AgentRail <waitlist@agentrail.dev>",
  brevoApiKey = null,
  brevoFromEmail = "waitlist@agentrail.dev",
  brevoFromName = "AgentRail"
}) {
  const url = new URL(request.url, "http://127.0.0.1");

  // Observability: intercept writeHead/end to capture status + emit log entry.
  const obs = { operation: null, agentId: null, taskId: null, idempotencyKey: request.headers["idempotency-key"] ?? null };
  const timer = createOperationTimer(obs);
  let capturedStatus = null;
  const origWriteHead = response.writeHead.bind(response);
  response.writeHead = (statusCode, ...rest) => {
    capturedStatus = statusCode;
    return origWriteHead(statusCode, ...rest);
  };
  const origEnd = response.end.bind(response);
  response.end = (body, ...rest) => {
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
  const isTaskRoute = /^\/(tasks|task-events|task-webhook-subscriptions|agent-api-keys)/.test(url.pathname);
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

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    serveStaticFile(response, path.join(__dirname, "..", "landing", "index-light.html"), "text/html");
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/demo.mp4") {
    serveStaticFile(response, path.join(__dirname, "..", "docs", "demo", "agentrail-e2e-demo.mp4"), "video/mp4");
    return;
  }

  if (request.method === "POST" && url.pathname === "/waitlist") {
    obs.operation = "waitlist_signup";
    await handleWaitlistSignup({ request, response, waitlistStore, emailWebhookUrl, emailWebhookToken, resendApiKey, resendFromEmail, sendgridApiKey, sendgridFromEmail, brevoApiKey, brevoFromEmail, brevoFromName });
    return;
  }

  if (request.method === "OPTIONS" && url.pathname === "/waitlist") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, idempotency-key"
    });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/agent-api-keys") {
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
      ? url.pathname.match(/^\/agent-api-keys\/(akey_[A-Za-z0-9]+)\/rotate$/)
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
      ? url.pathname.match(/^\/agent-api-keys\/(akey_[A-Za-z0-9]+)\/usage$/)
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

  if (request.method === "GET" && url.pathname === "/tasks/mine") {
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    handleListMyTasks({ response, url, taskLifecycleStore });
    return;
  }

  const taskDetailMatch =
    request.method === "GET" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    handleGetTask({
      response,
      taskLifecycleStore,
      taskId: taskDetailMatch[1]
    });
    return;
  }

  const submitMatch =
    request.method === "POST" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/submit$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    await handleSubmitTask({
      request,
      response,
      taskLifecycleStore,
      taskId: submitMatch[1]
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/task-events/stream") {
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

  if (request.method === "GET" && url.pathname === "/task-webhook-subscriptions") {
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

  if (request.method === "POST" && url.pathname === "/task-webhook-subscriptions") {
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

  if (request.method === "POST" && url.pathname === "/providers/circleci/webhooks") {
    await handleCircleCiWebhook({ request, response, ciStatusAdapter });
    return;
  }

  const ciStatusMatch =
    request.method === "GET" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/ci-status$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    await handleGetTaskCiStatus({
      response,
      ciStatusAdapter,
      taskId: ciStatusMatch[1]
    });
    return;
  }

  const reviewFeedbackMatch =
    request.method === "GET" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/review-feedback$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    await handleGetTaskReviewFeedback({
      response,
      reviewFeedbackAdapter,
      taskId: reviewFeedbackMatch[1]
    });
    return;
  }

  const shipMatch =
    request.method === "POST" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/ship$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

    await handleShipTask({
      request,
      response,
      taskLifecycleStore,
      taskId: shipMatch[1]
    });
    return;
  }

  const rollbackMatch =
    request.method === "POST" ? url.pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/rollback$/) : null;
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
    obs.agentId = principal?.agent?.subject ?? principal?.keyId ?? null;

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
      ? url.pathname.match(/^\/task-webhook-subscriptions\/(whsub_[A-Za-z0-9]+)$/)
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
      ? url.pathname.match(/^\/task-webhook-subscriptions\/(whsub_[A-Za-z0-9]+)$/)
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

function handleListMyTasks({ response, url, taskLifecycleStore }) {
  if (!taskLifecycleStore) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: []
    });
    return;
  }

  try {
    const body = taskLifecycleStore.listMyTasks({
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined
    });
    writeJson(response, 200, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

function handleGetTask({ response, taskLifecycleStore, taskId }) {
  if (!taskLifecycleStore) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const body = taskLifecycleStore.getTask(taskId);
    writeJson(response, 200, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

async function handleCreateAgentApiKey({ request, response, authStore, principal }) {
  try {
    const payload = await readJsonBody(request);
    if (!principal && !payload.scopes?.includes("auth:admin")) {
      writeError(response, 400, "validation_error", "Bootstrap key must include `auth:admin`.", {
        availableActions: ["retry"]
      });
      return;
    }

    const body = authStore.createKey(payload, request.headers["idempotency-key"]);
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

async function handleRotateAgentApiKey({ request, response, authStore, keyId }) {
  try {
    const payload = await readJsonBody(request);
    const body = authStore.rotateKey(keyId, payload, request.headers["idempotency-key"]);
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

function handleGetAgentApiKeyUsage({ response, authStore, keyId }) {
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

async function handleSubmitTask({ request, response, taskLifecycleStore, taskId }) {
  if (!taskLifecycleStore) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await taskLifecycleStore.submitTask(
      taskId,
      payload,
      request.headers["idempotency-key"]
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

async function handleGetTaskCiStatus({ response, ciStatusAdapter, taskId }) {
  let body = null;
  try {
    body = ciStatusAdapter ? await ciStatusAdapter.getTaskCiStatus(taskId) : null;
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

async function handleCircleCiWebhook({ request, response, ciStatusAdapter }) {
  if (!ciStatusAdapter || typeof ciStatusAdapter.receiveWebhook !== "function") {
    writeError(response, 404, "not_found", "CircleCI webhook source not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const rawBody = await readRequestBody(request);
    const body = await ciStatusAdapter.receiveWebhook({
      headers: request.headers,
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

async function handleGetTaskReviewFeedback({ response, reviewFeedbackAdapter, taskId }) {
  let body = null;
  try {
    body = reviewFeedbackAdapter ? await reviewFeedbackAdapter.getTaskReviewFeedback(taskId) : null;
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

async function handleShipTask({ request, response, taskLifecycleStore, taskId }) {
  if (!taskLifecycleStore) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await taskLifecycleStore.shipTask(
      taskId,
      payload,
      request.headers["idempotency-key"]
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

async function handleRollbackTask({ request, response, taskLifecycleStore, rollbackAdapter, taskId }) {
  if (!taskLifecycleStore && !rollbackAdapter) {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);

    let body;
    if (rollbackAdapter) {
      body = await rollbackAdapter.rollbackTask(
        taskId,
        payload,
        request.headers["idempotency-key"]
      );
    } else {
      body = await taskLifecycleStore.rollbackTask(
        taskId,
        payload,
        request.headers["idempotency-key"]
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

function handleTaskEventStream({ request, response, url, store, now }) {
  const heartbeatSeconds = clampHeartbeatSeconds(url.searchParams.get("heartbeatSeconds"));
  const filters = {
    taskId: url.searchParams.get("taskId") ?? undefined,
    eventTypes: parseEventTypes(url.searchParams.get("eventTypes"))
  };

  let replayEvents = [];
  let lastSentSequence = store.getMaxSequence();
  let resumeMode = "live";

  const resumeCursor = request.headers["last-event-id"] ?? url.searchParams.get("cursor");

  try {
    if (resumeCursor) {
      const referenceEvent = store.resolveCursor(resumeCursor);
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

  const sendEvent = (event) => {
    if (event.sequence <= lastSentSequence || !matchesFilters(event, filters)) {
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

function clampHeartbeatSeconds(rawValue) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_HEARTBEAT_SECONDS;
  }

  return Math.min(MAX_HEARTBEAT_SECONDS, Math.max(MIN_HEARTBEAT_SECONDS, parsed));
}

function parseEventTypes(rawValue) {
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

function ensureAuthStore({ response, authStore }) {
  if (authStore) {
    return true;
  }

  writeError(response, 503, "auth_store_unavailable", "Agent authentication store is not configured.", {
    availableActions: ["contact_support"]
  });
  return false;
}

function authorizeRoute({
  request,
  response,
  authStore,
  requiredScope,
  operation,
  allowBootstrap = false
}) {
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

async function handleCreateTaskWebhookSubscription({ request, response, webhookStore }) {
  try {
    const payload = await readJsonBody(request);
    const body = webhookStore.createSubscription(payload, request.headers["idempotency-key"]);
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

function handleListTaskWebhookSubscriptions({ response, webhookStore }) {
  const body = webhookStore.listSubscriptions();
  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function handleGetTaskWebhookSubscription({ response, webhookStore, subscriptionId }) {
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

function handleDeactivateTaskWebhookSubscription({ response, webhookStore, subscriptionId }) {
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

async function readJsonBody(request) {
  const rawBody = await readRequestBody(request);
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function writeError(response, statusCode, code, message, details, headers = {}) {
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

async function handleWaitlistSignup({ request, response, waitlistStore, emailWebhookUrl, emailWebhookToken, resendApiKey, resendFromEmail, sendgridApiKey, sendgridFromEmail, brevoApiKey, brevoFromEmail, brevoFromName }) {
  try {
    const payload = await readJsonBody(request);
    const result = waitlistStore.addEntry(payload, request.headers["idempotency-key"]);

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
        const headers = { "content-type": "application/json" };
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

async function sendBrevoConfirmation({ entry, apiKey, fromEmail, fromName }) {
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
    process.stderr.write(`[brevo] fetch error: ${err.message}\n`);
    return "failed";
  }
}

async function sendResendConfirmation({ entry, apiKey, from }) {
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
    process.stderr.write(`[resend] fetch error: ${err.message}\n`);
    return "failed";
  }
}

async function sendSendGridConfirmation({ entry, apiKey, from }) {
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
  const fromMatch = from.match(/^([^<]+)<([^>]+)>$/);
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
    process.stderr.write(`[sendgrid] fetch error: ${err.message}\n`);
    return "failed";
  }
}

function serveStaticFile(response, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found", details: {} } }));
  }
}

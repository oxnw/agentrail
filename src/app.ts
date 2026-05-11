import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { AgentAuthStore } from "./agent-auth-store.ts";
import { AgentAuthError } from "./agent-auth-store.ts";
import { CiStatusSourceError } from "./github-actions-ci-adapter.ts";
import type { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { ReviewFeedbackSourceError } from "./github-review-feedback-adapter.ts";
import { RollbackSourceError } from "./github-rollback-adapter.ts";
import { createSetupVerificationTask } from "./setup-verification-task.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { CursorExpiredError, matchesFilters, TaskEventStore } from "./task-event-store.ts";
import type { TaskRecord } from "./task-store.ts";
import {
  ConflictError,
  AgentRailEventSubscriptionStore,
  ValidationError
} from "./event-subscription-store.ts";
import { WaitlistStore, WaitlistValidationError } from "./waitlist-store.ts";
import { createOperationTimer, logNarrative } from "./structured-logger.ts";
import type { GitHubIssueIntakeAdapter } from "./github-issue-intake-adapter.ts";
import type { LinearIssueSourceAdapter } from "./linear-issue-source-adapter.ts";
import type { LinearCommentWebhookAdapter } from "./linear-comment-webhook-adapter.ts";
import type { AgentRunReportInput, AgentRunStore, AgentRunStatus } from "./agent-run-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_HEARTBEAT_SECONDS = 20;
const MIN_HEARTBEAT_SECONDS = 10;
const MAX_HEARTBEAT_SECONDS = 60;
const MAX_AGENT_RUN_LIST_LIMIT = 100;

type LinearIssueSourceAdapterLike = Partial<Pick<LinearIssueSourceAdapter, "ingest" | "receiveWebhook" | "createComment" | "updateIssueState" | "importIssue" | "refreshIssue">>;
type LinearCommentWebhookAdapterLike = Partial<Pick<LinearCommentWebhookAdapter, "receiveWebhook">>;
type TaskLifecycleStoreLike = {
  getTask?(taskId: string): unknown;
  getRawTask?(taskId: string): TaskRecord | null;
  blockTaskAwaitingUser?(taskId: string, payload: unknown, idempotencyKey: string | undefined, sourceAgentId: string | null): Promise<unknown> | unknown;
  resolveBlocker?(taskId: string, payload: unknown, idempotencyKey: string | undefined, actorId: string | null, actorRole?: string): Promise<unknown> | unknown;
  listRawTasks?(): TaskRecord[];
  listRawTasksBySourceRepo?(provider: "github" | "gitlab", owner: string, repo: string): TaskRecord[];
  projectCiState?(taskId: string, observation: {
    provider: string;
    overallStatus: string;
    summary?: Record<string, number>;
    headline?: string | null;
    updatedAt?: string | null;
  }): Promise<unknown> | unknown;
};

export interface CreateServerOptions {
  store: TaskEventStore;
  agentRunStore?: AgentRunStore | null;
  now?: () => Date;
  ciStatusAdapter?: { getTaskCiStatus?(taskId: string): Promise<unknown> | unknown; receiveWebhook?(payload: { headers: Record<string, string | string[]>; rawBody: string }): Promise<unknown> } | null;
  githubWebhookSecret?: string | null;
  reviewFeedbackAdapter?: { getTaskReviewFeedback?(taskId: string): Promise<unknown> | unknown } | null;
  rollbackAdapter?: { rollbackTask?(taskId: string, payload: unknown, idempotencyKey: string): Promise<unknown> } | null;
  intakeAdapter?: { ingest?(payload: unknown, idempotencyKey: string | undefined): Promise<unknown> } | null;
  linearIntakeAdapter?: LinearIssueSourceAdapterLike | null;
  linearIssueSourceAdapter?: LinearIssueSourceAdapterLike | null;
  linearWebhookAdapter?: LinearCommentWebhookAdapterLike | null;
  routingControlPlane?: RoutingControlPlane | null;
  authStore?: AgentAuthStore | null;
  eventSubscriptionStore?: AgentRailEventSubscriptionStore | null;
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
  agentRunStore = null,
  now = () => new Date(),
  ciStatusAdapter = null,
  githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || null,
  reviewFeedbackAdapter = null,
  rollbackAdapter = null,
  intakeAdapter = null,
  linearIntakeAdapter = null,
  linearIssueSourceAdapter = null,
  linearWebhookAdapter = null,
  routingControlPlane = null,
  authStore = null,
  eventSubscriptionStore = null,
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
  const resolvedEventSubscriptionStore = eventSubscriptionStore ?? new AgentRailEventSubscriptionStore({ now });
  const resolvedWaitlistStore = waitlistStore ?? new WaitlistStore({ now });
  const resolvedLinearIssueSourceAdapter = linearIssueSourceAdapter ?? linearIntakeAdapter;

  return http.createServer((request, response) => {
    void routeRequest({
      request,
      response,
      store,
      agentRunStore,
      eventSubscriptionStore: resolvedEventSubscriptionStore,
      now,
      ciStatusAdapter,
      githubWebhookSecret,
      reviewFeedbackAdapter,
      rollbackAdapter,
      intakeAdapter,
      linearIntakeAdapter: resolvedLinearIssueSourceAdapter,
      linearIssueSourceAdapter: resolvedLinearIssueSourceAdapter,
      linearWebhookAdapter,
      routingControlPlane,
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
  eventSubscriptionStore: AgentRailEventSubscriptionStore;
  intakeAdapter?: { ingest?(payload: unknown, idempotencyKey: string | undefined): Promise<unknown> } | null;
  linearIntakeAdapter?: LinearIssueSourceAdapterLike | null;
  linearIssueSourceAdapter?: LinearIssueSourceAdapterLike | null;
  linearWebhookAdapter?: LinearCommentWebhookAdapterLike | null;
}

async function routeRequest({
  request,
  response,
  store,
  agentRunStore,
  eventSubscriptionStore,
  now,
  ciStatusAdapter,
  githubWebhookSecret = null,
  reviewFeedbackAdapter,
  rollbackAdapter,
  intakeAdapter = null,
  linearIntakeAdapter = null,
  linearIssueSourceAdapter = null,
  linearWebhookAdapter = null,
  routingControlPlane = null,
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
  const resolvedLinearIssueSourceAdapter = linearIssueSourceAdapter;
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
  const isTaskRoute = /^\/(tasks|task-events|event-subscriptions|agent-api-keys)/.test(pathname);
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

  if (request.method === "GET" && pathname === "/operator/routing/rule-sets/current") {
    obs.operation = "get_current_routing_rule_set";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:read",
      operation: "get_current_routing_rule_set"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleGetCurrentRoutingRuleSet({ response, routingControlPlane });
    return;
  }

  if (request.method === "PUT" && pathname === "/operator/routing/rule-sets/current") {
    obs.operation = "replace_current_routing_rule_set";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:admin",
      operation: "replace_current_routing_rule_set"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleReplaceCurrentRoutingRuleSet({
      request,
      response,
      routingControlPlane,
      actorId: principal?.agent?.id ?? principal?.keyId ?? "system"
    });
    return;
  }

  const getAgentProfileMatch =
    request.method === "GET"
      ? pathname.match(/^\/operator\/routing\/agent-profiles\/(agt_[A-Za-z0-9_]+)$/)
      : null;
  if (getAgentProfileMatch) {
    obs.operation = "get_routing_agent_profile";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:read",
      operation: "get_routing_agent_profile"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleGetRoutingAgentProfile({
      response,
      routingControlPlane,
      agentId: getAgentProfileMatch[1]
    });
    return;
  }

  const putAgentProfileMatch =
    request.method === "PUT"
      ? pathname.match(/^\/operator\/routing\/agent-profiles\/(agt_[A-Za-z0-9_]+)$/)
      : null;
  if (putAgentProfileMatch) {
    obs.operation = "replace_routing_agent_profile";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:admin",
      operation: "replace_routing_agent_profile"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleReplaceRoutingAgentProfile({
      request,
      response,
      routingControlPlane,
      agentId: putAgentProfileMatch[1],
      actorId: principal?.agent?.id ?? principal?.keyId ?? "system"
    });
    return;
  }

  if (request.method === "POST" && pathname === "/operator/routing/evaluations") {
    obs.operation = "evaluate_routing";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:evaluate",
      operation: "evaluate_routing"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleEvaluateRouting({
      request,
      response,
      routingControlPlane
    });
    return;
  }

  if (request.method === "POST" && pathname === "/operator/intake/provider-issues") {
    obs.operation = "ingest_provider_issue";
    obs.provider = "routing_control_plane";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:admin",
      operation: "ingest_provider_issue"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleIngestProviderIssue({
      request,
      response,
      routingControlPlane
    });
    return;
  }

  const routingAuditMatch =
    request.method === "GET"
      ? pathname.match(/^\/operator\/routing\/audit\/(rdec_[A-Za-z0-9]+)$/)
      : null;
  if (routingAuditMatch) {
    obs.operation = "get_routing_audit";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:read",
      operation: "get_routing_audit"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleGetRoutingAudit({
      response,
      routingControlPlane,
      decisionId: routingAuditMatch[1]
    });
    return;
  }

  if (request.method === "POST" && pathname === "/operator/setup/verification-task") {
    obs.operation = "create_setup_verification_task";
    obs.provider = "setup_verification";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:admin",
      operation: "create_setup_verification_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleCreateSetupVerificationTask({
      request,
      response,
      routingControlPlane,
      taskLifecycleStore,
      now
    });
    return;
  }

  if (request.method === "GET" && pathname === "/operator/agent-runs") {
    obs.operation = "list_agent_runs";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "usage:read",
      operation: "list_agent_runs"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleListAgentRuns({
      response,
      url,
      agentRunStore,
    });
    return;
  }

  const agentRunMatch =
    request.method === "GET"
      ? pathname.match(/^\/operator\/agent-runs\/(run_[A-Za-z0-9_]+)$/)
      : null;
  if (agentRunMatch) {
    obs.operation = "get_agent_run";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "usage:read",
      operation: "get_agent_run"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    handleGetAgentRun({
      response,
      agentRunStore,
      runId: agentRunMatch[1],
    });
    return;
  }

  const agentRunReportMatch =
    request.method === "POST"
      ? pathname.match(/^\/agent-runs\/(run_[A-Za-z0-9_]+)\/report$/)
      : null;
  if (agentRunReportMatch) {
    obs.operation = "report_agent_run";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "report_agent_run"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleReportAgentRun({
      request,
      response,
      agentRunStore,
      taskLifecycleStore,
      runId: agentRunReportMatch[1],
      principal,
    });
    return;
  }

  const repairTaskSourceMatch =
    request.method === "PATCH"
      ? pathname.match(/^\/operator\/tasks\/(tsk_[A-Za-z0-9]+)\/source$/)
      : null;
  if (repairTaskSourceMatch) {
    obs.operation = "repair_task_source";
    obs.taskId = repairTaskSourceMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "routing:admin",
      operation: "repair_task_source"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleRepairTaskSource({
      request,
      response,
      taskLifecycleStore,
      taskId: repairTaskSourceMatch[1],
      actorId: principal?.agent?.id ?? principal?.keyId ?? "system",
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
      taskId: taskDetailMatch[1],
      principal
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

  const startMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/start$/) : null;
  if (startMatch) {
    obs.operation = "start_task";
    obs.taskId = startMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "start_task"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleStartTask({
      request,
      response,
      taskLifecycleStore,
      taskId: startMatch[1],
      actorId: principal?.agent?.id ?? null,
    });
    return;
  }

  const blockTaskMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/blocker$/) : null;
  if (blockTaskMatch) {
    obs.operation = "block_task_awaiting_user";
    obs.taskId = blockTaskMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "block_task_awaiting_user"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleBlockTaskAwaitingUser({
      request,
      response,
      taskLifecycleStore,
      taskId: blockTaskMatch[1],
      sourceAgentId: principal?.agent?.id ?? null,
    });
    return;
  }

  const resolveBlockerMatch =
    request.method === "POST" ? pathname.match(/^\/tasks\/(tsk_[A-Za-z0-9]+)\/resolve-blocker$/) : null;
  if (resolveBlockerMatch) {
    obs.operation = "resolve_task_blocker";
    obs.taskId = resolveBlockerMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "resolve_task_blocker"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleResolveTaskBlocker({
      request,
      response,
      taskLifecycleStore,
      taskId: resolveBlockerMatch[1],
      actorId: principal?.agent?.id ?? principal?.keyId ?? null,
      actorRole: principal?.agent?.role ?? "system",
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

  if (request.method === "GET" && pathname === "/event-subscriptions") {
    obs.operation = "list_event_subscriptions";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:read",
      operation: "list_event_subscriptions"
    });
    if (principal === false) {
      return;
    }

    handleListEventSubscriptions({ response, eventSubscriptionStore });
    return;
  }

  if (request.method === "POST" && pathname === "/event-subscriptions") {
    obs.operation = "create_event_subscription";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:write",
      operation: "create_event_subscription"
    });
    if (principal === false) {
      return;
    }

    await handleCreateEventSubscription({ request, response, eventSubscriptionStore, store });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/circleci/webhooks") {
    await handleCircleCiWebhook({ request, response, ciStatusAdapter, taskLifecycleStore });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/github/webhooks") {
    obs.operation = "github_webhook";
    obs.provider = "github";
    await handleGitHubWebhook({ request, response, githubWebhookSecret, intakeAdapter, ciStatusAdapter, taskLifecycleStore });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/github/intake") {
    obs.operation = "github_issue_intake";
    obs.provider = "github";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "github_issue_intake"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleGitHubIssueIntake({
      request,
      response,
      intakeAdapter,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/linear/intake") {
    obs.operation = "linear_issue_intake";
    obs.provider = "linear";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "linear_issue_intake"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleLinearIssueIntake({
      request,
      response,
      linearIntakeAdapter: resolvedLinearIssueSourceAdapter,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/linear/import") {
    obs.operation = "linear_issue_import";
    obs.provider = "linear";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "tasks:write",
      operation: "linear_issue_import"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleLinearIssueImport({
      request,
      response,
      linearIntakeAdapter: resolvedLinearIssueSourceAdapter,
    });
    return;
  }

  const linearCommentMatch =
    request.method === "POST" ? pathname.match(/^\/providers\/linear\/tasks\/(tsk_[A-Za-z0-9]+)\/comments$/) : null;
  if (linearCommentMatch) {
    obs.operation = "linear_create_comment";
    obs.provider = "linear";
    obs.taskId = linearCommentMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "providers:write",
      operation: "linear_create_comment"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleCreateLinearTaskComment({
      request,
      response,
      taskLifecycleStore,
      linearIssueSourceAdapter: resolvedLinearIssueSourceAdapter,
      taskId: linearCommentMatch[1],
      now
    });
    return;
  }

  const linearWorkflowStateMatch =
    request.method === "POST" ? pathname.match(/^\/providers\/linear\/tasks\/(tsk_[A-Za-z0-9]+)\/workflow-state$/) : null;
  if (linearWorkflowStateMatch) {
    obs.operation = "linear_update_workflow_state";
    obs.provider = "linear";
    obs.taskId = linearWorkflowStateMatch[1];
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "providers:write",
      operation: "linear_update_workflow_state"
    });
    if (principal === false) {
      return;
    }
    obs.agentId = principal?.agent?.id ?? principal?.keyId ?? null;

    await handleUpdateLinearWorkflowState({
      request,
      response,
      taskLifecycleStore,
      linearIssueSourceAdapter: resolvedLinearIssueSourceAdapter,
      taskId: linearWorkflowStateMatch[1],
      now
    });
    return;
  }

  if (request.method === "POST" && pathname === "/providers/linear/webhooks") {
    obs.operation = "linear_webhook";
    obs.provider = "linear";
    await handleLinearWebhook({
      request,
      response,
      linearIntakeAdapter: resolvedLinearIssueSourceAdapter,
      linearWebhookAdapter,
    });
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

  const getEventSubscriptionMatch =
    request.method === "GET"
      ? pathname.match(/^\/event-subscriptions\/(evsub_[A-Za-z0-9]+)$/)
      : null;
  if (getEventSubscriptionMatch) {
    obs.operation = "get_event_subscription";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:read",
      operation: "get_event_subscription"
    });
    if (principal === false) {
      return;
    }

    handleGetEventSubscription({
      response,
      eventSubscriptionStore,
      subscriptionId: getEventSubscriptionMatch[1]
    });
    return;
  }

  const deleteMatch =
    request.method === "DELETE"
      ? pathname.match(/^\/event-subscriptions\/(evsub_[A-Za-z0-9]+)$/)
      : null;
  if (deleteMatch) {
    obs.operation = "deactivate_event_subscription";
    const principal = authorizeRoute({
      request,
      response,
      authStore,
      requiredScope: "webhooks:write",
      operation: "deactivate_event_subscription"
    });
    if (principal === false) {
      return;
    }

    handleDeactivateEventSubscription({
      response,
      eventSubscriptionStore,
      subscriptionId: deleteMatch[1]
    });
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify({ error: { code: "not_found", message: "Not found", details: {} } }));
}

interface AgentPrincipalLike {
  agent?: { id?: string };
  keyId?: string;
}

interface ListMyTasksOptions {
  response: http.ServerResponse;
  url: URL;
  taskLifecycleStore: unknown;
  principal: ReturnType<AgentAuthStore["authenticate"]> | null;
}

function handleListMyTasks({ response, url, taskLifecycleStore, principal }: ListMyTasksOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { listMyTasks?: unknown }).listMyTasks !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: []
    });
    return;
  }

  try {
    const body = (taskLifecycleStore as { listMyTasks: (opts: Record<string, unknown>) => unknown }).listMyTasks({
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      assigneeAgentId: principal?.agent?.id ?? undefined
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

interface GetTaskOptions {
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  taskId: string;
  principal: ReturnType<AgentAuthStore["authenticate"]> | null;
}

interface AgentRunListOptions {
  response: http.ServerResponse;
  url: URL;
  agentRunStore?: AgentRunStore | null;
}

function handleListAgentRuns({ response, url, agentRunStore }: AgentRunListOptions) {
  if (!agentRunStore) {
    writeError(response, 404, "not_found", "Agent run store is not configured.", {
      availableActions: []
    });
    return;
  }

  const statusParam = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  if (limitParam && (!/^\d+$/u.test(limitParam) || !Number.isFinite(limit) || (limit ?? 0) <= 0 || (limit ?? 0) > MAX_AGENT_RUN_LIST_LIMIT)) {
    writeError(response, 400, "validation_error", `limit must be between 1 and ${MAX_AGENT_RUN_LIST_LIMIT}.`, {
      availableActions: ["retry"]
    });
    return;
  }

  const status: AgentRunStatus | undefined = isAgentRunStatus(statusParam) ? statusParam : undefined;
  if (statusParam && status === undefined) {
    writeError(response, 400, "validation_error", "Invalid status filter value.", {
      availableActions: ["retry"]
    });
    return;
  }

  writeJson(response, 200, {
    data: agentRunStore.listRuns({
      agentId: url.searchParams.get("agentId") ?? undefined,
      status,
      limit,
    }),
    availableActions: [],
    meta: responseMeta()
  });
}

interface GetAgentRunOptions {
  response: http.ServerResponse;
  agentRunStore?: AgentRunStore | null;
  runId: string;
}

function handleGetAgentRun({ response, agentRunStore, runId }: GetAgentRunOptions) {
  if (!agentRunStore) {
    writeError(response, 404, "not_found", "Agent run store is not configured.", {
      availableActions: []
    });
    return;
  }

  const run = agentRunStore.getRun(runId);
  if (!run) {
    writeError(response, 404, "not_found", "Agent run not found.", {
      availableActions: ["list_agent_runs"]
    });
    return;
  }

  writeJson(response, 200, {
    data: run,
    availableActions: [],
    meta: responseMeta()
  });
}

interface ReportAgentRunOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  agentRunStore?: AgentRunStore | null;
  taskLifecycleStore: unknown;
  runId: string;
  principal: ReturnType<AgentAuthStore["authenticate"]> | null;
}

async function handleReportAgentRun({ request, response, agentRunStore, taskLifecycleStore, runId, principal }: ReportAgentRunOptions) {
  if (!agentRunStore) {
    writeError(response, 404, "not_found", "Agent run store is not configured.", {
      availableActions: []
    });
    return;
  }

  const run = agentRunStore.getRun(runId);
  if (!run) {
    writeError(response, 404, "not_found", "Agent run not found.", {
      availableActions: ["list_agent_runs"]
    });
    return;
  }

  if (!canReportAgentRun(run.agentId, principal)) {
    writeError(response, 403, "forbidden", "Agent run is not assigned to this agent.", {
      availableActions: []
    });
    return;
  }

  const payload = await readJsonBody(request);
  if (!isRecord(payload)) {
    writeError(response, 400, "validation_error", "Report body must be a JSON object.", {
      availableActions: ["retry"]
    });
    return;
  }

  const status = payload.status;
  const summary = payload.summary;
  if (status !== "progress" && status !== "blocked" && status !== "completed") {
    writeError(response, 400, "validation_error", "Report status must be progress, blocked, or completed.", {
      availableActions: ["retry"]
    });
    return;
  }
  if (typeof summary !== "string" || summary.trim().length === 0) {
    writeError(response, 400, "validation_error", "Report summary must be a non-empty string.", {
      availableActions: ["retry"]
    });
    return;
  }
  const blockedReason = status === "blocked" ? validateRequiredPayloadString(payload, "reason") : null;
  if (blockedReason instanceof Error) {
    writeError(response, 400, "validation_error", blockedReason.message, {
      availableActions: ["retry"]
    });
    return;
  }
  const blockedActionRequired = status === "blocked" ? validateRequiredPayloadString(payload, "actionRequired") : null;
  if (blockedActionRequired instanceof Error) {
    writeError(response, 400, "validation_error", blockedActionRequired.message, {
      availableActions: ["retry"]
    });
    return;
  }
  const blockedResumeInstructions = status === "blocked" ? validateRequiredPayloadString(payload, "resumeInstructions") : null;
  if (blockedResumeInstructions instanceof Error) {
    writeError(response, 400, "validation_error", blockedResumeInstructions.message, {
      availableActions: ["retry"]
    });
    return;
  }
  if (payload.handoff !== undefined && payload.handoff !== null && !isRecord(payload.handoff)) {
    writeError(response, 400, "validation_error", "Report handoff must be a JSON object or null when provided.", {
      availableActions: ["retry"]
    });
    return;
  }

  let report: AgentRunReportInput;
  if (status === "blocked") {
    if (typeof blockedReason !== "string" || typeof blockedActionRequired !== "string" || typeof blockedResumeInstructions !== "string") {
      writeError(response, 400, "validation_error", "Blocked reports require reason, actionRequired, and resumeInstructions.", {
        availableActions: ["retry"]
      });
      return;
    }
    report = {
      status,
      summary,
      reason: blockedReason,
      actionRequired: blockedActionRequired,
      resumeInstructions: blockedResumeInstructions,
    };
  } else {
    report = {
      status,
      summary,
    };
  }
  if (payload.handoff !== undefined) {
    report.handoff = payload.handoff === null ? null : payload.handoff as Record<string, unknown>;
  }
  if (report.status === "blocked") {
    const lifecycle = taskLifecycleStore as TaskLifecycleStoreLike | null | undefined;
    if (!lifecycle || typeof lifecycle.blockTaskAwaitingUser !== "function") {
      writeError(response, 404, "not_found", "Task lifecycle store is not configured for blocked reports.", {
        availableActions: ["contact_support"]
      });
      return;
    }
    try {
      await lifecycle.blockTaskAwaitingUser(
        run.taskId,
        {
          sourceRunId: run.runId,
          sourceAgentId: run.agentId,
          reason: report.reason,
          actionRequired: report.actionRequired,
          resumeInstructions: report.resumeInstructions,
        },
        `agent-run-blocker:${run.runId}`,
        run.agentId,
      );
    } catch (error) {
      if (error instanceof TaskLifecycleError) {
        writeError(response, error.statusCode, error.code, error.message, error.details);
        return;
      }
      throw error;
    }
  }

  let updated: ReturnType<AgentRunStore["reportRun"]>;
  try {
    updated = agentRunStore.reportRun(runId, report);
  } catch (error) {
    if (status === "blocked") {
      await rollbackBlockedReportTask({ taskLifecycleStore, taskId: run.taskId, runId: run.runId, agentId: run.agentId });
    }
    throw error;
  }
  if (!updated) {
    if (status === "blocked") {
      await rollbackBlockedReportTask({ taskLifecycleStore, taskId: run.taskId, runId: run.runId, agentId: run.agentId });
    }
    writeError(response, 404, "not_found", "Agent run not found.", {
      availableActions: ["list_agent_runs"]
    });
    return;
  }

  writeJson(response, 202, {
    data: updated,
    availableActions: [],
    meta: responseMeta()
  });
}

async function rollbackBlockedReportTask({
  taskLifecycleStore,
  taskId,
  runId,
  agentId,
}: {
  taskLifecycleStore: unknown;
  taskId: string;
  runId: string;
  agentId: string;
}): Promise<void> {
  const lifecycle = taskLifecycleStore as TaskLifecycleStoreLike | null | undefined;
  if (!lifecycle || typeof lifecycle.resolveBlocker !== "function") {
    return;
  }
  try {
    await lifecycle.resolveBlocker(
      taskId,
      { resolutionSummary: "Rolled back awaiting-user blocker because the agent run report could not be persisted." },
      `agent-run-blocker-rollback:${runId}`,
      agentId,
      "system",
    );
  } catch (rollbackError) {
    logNarrative({
      title: "Agent Run Blocker Rollback Failed",
      message: `Failed to roll back awaiting-user blocker for task ${taskId} after agent run report persistence failed.`,
      operation: "agent_run_blocker_rollback_failed",
      taskId,
      details: {
        runId,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      },
    });
  }
}

function validateRequiredPayloadString(payload: Record<string, unknown>, fieldName: string): string | Error {
  const value = payload[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    return new Error(`Report ${fieldName} must be a non-empty string for blocked reports.`);
  }
  return value.trim();
}

function canReportAgentRun(runAgentId: string, principal: ReturnType<AgentAuthStore["authenticate"]> | null): boolean {
  if (!principal) return true;
  if (principal.scopes.includes("auth:admin")) return true;
  return principal.agent?.id === runAgentId;
}

function handleGetTask({ response, taskLifecycleStore, taskId, principal }: GetTaskOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { getTask?: unknown }).getTask !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const body = (taskLifecycleStore as { getTask: (id: string) => unknown }).getTask(taskId);
    if (principal && !isTaskVisibleToPrincipal(body, principal)) {
      writeError(response, 403, "forbidden", "Task is not visible to you.", {
        availableActions: ["list_my_tasks"]
      });
      return;
    }
    writeJson(response, 200, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

function isTaskVisibleToPrincipal(body: unknown, principal: ReturnType<AgentAuthStore["authenticate"]> | null): boolean {
  if (!principal) return true;
  const principalAgentId = principal.agent?.id;
  if (!principalAgentId) return false;

  const taskBody = body as { data?: { assigneeAgentId?: string | null; assignee?: { id?: string } } } | null;
  const assigneeAgentId = taskBody?.data?.assigneeAgentId;
  if (typeof assigneeAgentId === "string" && assigneeAgentId.length > 0) {
    return assigneeAgentId === principalAgentId;
  }
  if (assigneeAgentId === null) return false;

  const legacyAssigneeId = taskBody?.data?.assignee?.id;
  if (!legacyAssigneeId) return true;
  return legacyAssigneeId === principalAgentId;
}

function isAgentRunStatus(value: string | null): value is AgentRunStatus {
  return value === "starting"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "awaiting_user"
    || value === "cancelled";
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

function responseMeta() {
  return {
    requestId: `req_${Date.now().toString(36)}`
  };
}

function ensureRoutingControlPlane({
  response,
  routingControlPlane
}: {
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
}) {
  if (routingControlPlane) {
    return true;
  }

  writeError(response, 404, "not_found", "Routing control plane is not configured.", {
    availableActions: ["contact_support"]
  });
  return false;
}

function handleGetCurrentRoutingRuleSet({
  response,
  routingControlPlane
}: {
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  const data = routingControlPlane.getCurrentRuleSet();
  if (!data) {
    writeError(response, 404, "not_found", "No active routing rule set is configured.", {
      availableActions: ["create_rule_set"]
    });
    return;
  }

  writeJson(response, 200, {
    data,
    availableActions: ["update", "evaluate"],
    meta: responseMeta()
  });
}

async function handleReplaceCurrentRoutingRuleSet({
  request,
  response,
  routingControlPlane,
  actorId
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
  actorId: string;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const data = routingControlPlane.replaceRuleSet(
      payload as Parameters<RoutingControlPlane["replaceRuleSet"]>[0],
      actorId,
      idempotencyKey
    );
    writeJson(response, 201, {
      data,
      availableActions: ["update", "evaluate"],
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }
}

function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
      availableActions: ["retry"]
    });
  }
  return value;
}

function handleGetRoutingAgentProfile({
  response,
  routingControlPlane,
  agentId
}: {
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
  agentId: string;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  const data = routingControlPlane.getAgentProfile(agentId);
  if (!data) {
    writeError(response, 404, "not_found", "Routing agent profile not found.", {
      availableActions: ["create_profile"]
    });
    return;
  }

  writeJson(response, 200, {
    data,
    availableActions: ["update"],
    meta: responseMeta()
  });
}

async function handleReplaceRoutingAgentProfile({
  request,
  response,
  routingControlPlane,
  agentId,
  actorId
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
  agentId: string;
  actorId: string;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const data = routingControlPlane.replaceAgentProfile(
      agentId,
      payload as Parameters<RoutingControlPlane["replaceAgentProfile"]>[1],
      actorId,
      idempotencyKey
    );
    writeJson(response, 200, {
      data,
      availableActions: ["update"],
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }
}

async function handleEvaluateRouting({
  request,
  response,
  routingControlPlane
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const data = await routingControlPlane.evaluate(
      payload as Parameters<RoutingControlPlane["evaluate"]>[0],
      idempotencyKey
    );
    writeJson(response, 200, {
      data,
      availableActions: data.availableActions,
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }
}

async function handleIngestProviderIssue({
  request,
  response,
  routingControlPlane
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const data = await routingControlPlane.ingestProviderIssue(
      payload as Parameters<RoutingControlPlane["ingestProviderIssue"]>[0],
      idempotencyKey
    );
    writeJson(response, 202, {
      data,
      availableActions: data.availableActions,
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }
}

function handleGetRoutingAudit({
  response,
  routingControlPlane,
  decisionId
}: {
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
  decisionId: string;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  const data = routingControlPlane.getRoutingAudit(decisionId);
  if (!data) {
    writeError(response, 404, "not_found", "Routing audit record not found.", {
      availableActions: ["view_rule_set"]
    });
    return;
  }

  writeJson(response, 200, {
    data,
    availableActions: ["view_rule_set"],
    meta: responseMeta()
  });
}

async function handleCreateSetupVerificationTask({
  request,
  response,
  routingControlPlane,
  taskLifecycleStore,
  now
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  routingControlPlane: RoutingControlPlane | null | undefined;
  taskLifecycleStore: unknown;
  now: () => Date;
}) {
  if (!ensureRoutingControlPlane({ response, routingControlPlane })) {
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const body = createSetupVerificationTask({
      payload: payload as Parameters<typeof createSetupVerificationTask>[0]["payload"],
      routingControlPlane,
      taskLifecycleStore,
      idempotencyKey,
      now
    });
    writeJson(response, 201, {
      ...body,
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }
}

async function handleRepairTaskSource({
  request,
  response,
  taskLifecycleStore,
  taskId,
  actorId,
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  taskId: string;
  actorId: string;
}) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { repairTaskSource?: unknown }).repairTaskSource !== "function") {
    writeError(response, 404, "not_found", "Task source repair is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const body = (taskLifecycleStore as {
      repairTaskSource: (taskId: string, payload: unknown, actorId: string, idempotencyKey: string) => unknown;
    }).repairTaskSource(taskId, payload, actorId, idempotencyKey) as Record<string, unknown>;
    writeJson(response, 200, {
      ...body,
      meta: responseMeta()
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
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

interface StartTaskOptions extends SubmitTaskOptions {
  actorId: string | null;
}

interface BlockTaskAwaitingUserOptions extends SubmitTaskOptions {
  sourceAgentId: string | null;
}

interface ResolveTaskBlockerOptions extends SubmitTaskOptions {
  actorId: string | null;
  actorRole: string;
}

async function handleStartTask({ request, response, taskLifecycleStore, taskId, actorId }: StartTaskOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { startTask?: unknown }).startTask !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await (taskLifecycleStore as {
      startTask: (taskId: string, payload: unknown, key: string | undefined, actorId: string | null) => Promise<unknown> | unknown;
    }).startTask(
      taskId,
      payload,
      request.headers["idempotency-key"] as string | undefined,
      actorId,
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

async function handleBlockTaskAwaitingUser({ request, response, taskLifecycleStore, taskId, sourceAgentId }: BlockTaskAwaitingUserOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { blockTaskAwaitingUser?: unknown }).blockTaskAwaitingUser !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await (taskLifecycleStore as {
      blockTaskAwaitingUser: (taskId: string, payload: unknown, key: string | undefined, sourceAgentId: string | null) => Promise<unknown> | unknown;
    }).blockTaskAwaitingUser(
      taskId,
      payload,
      request.headers["idempotency-key"] as string | undefined,
      sourceAgentId,
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

async function handleResolveTaskBlocker({ request, response, taskLifecycleStore, taskId, actorId, actorRole }: ResolveTaskBlockerOptions) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { resolveBlocker?: unknown }).resolveBlocker !== "function") {
    writeError(response, 404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await (taskLifecycleStore as {
      resolveBlocker: (taskId: string, payload: unknown, key: string | undefined, actorId: string | null, actorRole?: string) => Promise<unknown> | unknown;
    }).resolveBlocker(
      taskId,
      payload,
      request.headers["idempotency-key"] as string | undefined,
      actorId,
      actorRole,
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
  ciStatusAdapter: { receiveWebhook?(payload: { headers: Record<string, string | string[]>; rawBody: string }): Promise<unknown>; getTaskCiStatus?(taskId: string): Promise<unknown> | unknown } | null;
  taskLifecycleStore: TaskLifecycleStoreLike | null | unknown;
}

async function handleCircleCiWebhook({ request, response, ciStatusAdapter, taskLifecycleStore }: CircleCiWebhookOptions) {
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
    logNarrative({
      title: "Webhook Received",
      message: describeWebhookReceipt("CircleCI", body as Record<string, unknown>),
      operation: "circleci_webhook_receipt",
      provider: "circleci",
    });
    await projectMatchedCiTasks({
      taskLifecycleStore,
      ciStatusAdapter,
      matchedTaskIds: Array.isArray((body as any)?.data?.matchedTasks) ? (body as any).data.matchedTasks : [],
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

interface GitHubWebhookOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  githubWebhookSecret: string | null;
  intakeAdapter: { ingest?(payload: unknown, idempotencyKey: string | undefined): Promise<unknown> } | null;
  ciStatusAdapter: { getTaskCiStatus?(taskId: string): Promise<unknown> | unknown } | null;
  taskLifecycleStore: TaskLifecycleStoreLike | null | unknown;
}

async function handleGitHubWebhook({
  request,
  response,
  githubWebhookSecret,
  intakeAdapter,
  ciStatusAdapter,
  taskLifecycleStore,
}: GitHubWebhookOptions) {
  if (!githubWebhookSecret) {
    writeError(response, 404, "not_found", "GitHub webhook source not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  let rawBody: string;
  let payload: Record<string, any>;
  try {
    rawBody = await readRequestBody(request);
    verifyGitHubWebhook({
      rawBody,
      signatureHeader: request.headers["x-hub-signature-256"],
      secret: githubWebhookSecret,
    });
    payload = JSON.parse(rawBody || "{}") as Record<string, any>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeError(response, 400, "validation_error", "Request body must be valid JSON.", {
        availableActions: ["retry"]
      });
      return;
    }
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }
    throw error;
  }

  const eventName = typeof request.headers["x-github-event"] === "string" ? request.headers["x-github-event"] : null;
  const deliveryId = typeof request.headers["x-github-delivery"] === "string" ? request.headers["x-github-delivery"] : undefined;

  if (eventName === "issues" && intakeAdapter?.ingest && payload.issue && !payload.issue.pull_request) {
    const repoOwner = payload.repository?.owner?.login ?? payload.repository?.owner?.name ?? null;
    const repoName = payload.repository?.name ?? null;
    if (repoOwner && repoName) {
      logNarrative({
        title: "Webhook Received",
        message: `GitHub issue event received for ${repoOwner}/${repoName}#${payload.issue.number}`,
        operation: "github_webhook_receipt",
        provider: "github",
      });
      const body = await intakeAdapter.ingest({
        issueNumber: payload.issue.number,
        issueUrl: payload.issue.html_url,
        issueTitle: payload.issue.title,
        body: payload.issue.body ?? "",
        labels: Array.isArray(payload.issue.labels) ? payload.issue.labels.map((label: any) => typeof label === "string" ? label : label?.name).filter(Boolean) : [],
        state: payload.issue.state,
        repository: { owner: repoOwner, repo: repoName },
        assignees: Array.isArray(payload.issue.assignees) ? payload.issue.assignees : [],
      }, deliveryId);
      writeJson(response, 202, body);
      return;
    }
  }

  if (eventName === "workflow_run") {
    logNarrative({
      title: "Webhook Received",
      message: "GitHub Actions workflow_run event received",
      operation: "github_workflow_webhook_receipt",
      provider: "github_actions",
    });
    const matchedTaskIds = matchGitHubWorkflowTasks(taskLifecycleStore, payload);
    await projectMatchedCiTasks({
      taskLifecycleStore,
      ciStatusAdapter,
      matchedTaskIds,
    });
    writeJson(response, 202, {
      data: {
        accepted: true,
        deduplicated: false,
        matchedTasks: matchedTaskIds,
      },
      availableActions: matchedTaskIds.length > 0 ? ["get_task"] : [],
    });
    return;
  }

  writeJson(response, 202, {
    data: {
      accepted: true,
      deduplicated: false,
      matchedTasks: [],
      ignored: true,
    },
    availableActions: [],
  });
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

interface CreateEventSubscriptionOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  eventSubscriptionStore: AgentRailEventSubscriptionStore;
  store: TaskEventStore;
}

async function handleCreateEventSubscription({ request, response, eventSubscriptionStore, store }: CreateEventSubscriptionOptions) {
  try {
    const payload = await readJsonBody(request);
    const body = eventSubscriptionStore.createSubscription(
      payload as Parameters<AgentRailEventSubscriptionStore["createSubscription"]>[0],
      request.headers["idempotency-key"] as string,
      { createdAfterSequence: store.getMaxSequence() },
    );
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

function handleListEventSubscriptions({ response, eventSubscriptionStore }: { response: http.ServerResponse; eventSubscriptionStore: AgentRailEventSubscriptionStore }) {
  const body = eventSubscriptionStore.listSubscriptions();
  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function handleGetEventSubscription({ response, eventSubscriptionStore, subscriptionId }: { response: http.ServerResponse; eventSubscriptionStore: AgentRailEventSubscriptionStore; subscriptionId: string }) {
  const body = eventSubscriptionStore.getSubscription(subscriptionId);
  if (!body) {
    writeError(response, 404, "not_found", "Event subscription not found.", {
      availableActions: ["list_event_subscriptions", "create_event_subscription"],
    });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function handleDeactivateEventSubscription({ response, eventSubscriptionStore, subscriptionId }: { response: http.ServerResponse; eventSubscriptionStore: AgentRailEventSubscriptionStore; subscriptionId: string }) {
  const body = eventSubscriptionStore.deactivateSubscription(subscriptionId);
  if (!body) {
    writeError(response, 404, "not_found", "Event subscription not found.", {
      availableActions: ["list_event_subscriptions", "create_event_subscription"],
    });
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
<p>In the meantime, the source-available package is ready to use today:</p>
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
<p>In the meantime, the source-available package is ready to use today:</p>
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
<p>In the meantime, the source-available package is ready to use today:</p>
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

interface GitHubIssueIntakeOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  intakeAdapter: { ingest?(payload: unknown, idempotencyKey: string | undefined): Promise<unknown> } | null;
}

interface LinearIssueIntakeOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  linearIntakeAdapter: LinearIssueSourceAdapterLike | null | undefined;
}

interface LinearWebhookOptions extends LinearIssueIntakeOptions {
  linearWebhookAdapter: LinearCommentWebhookAdapterLike | null | undefined;
}

interface LinearOutboundOptions {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  taskLifecycleStore: unknown;
  linearIssueSourceAdapter: LinearIssueSourceAdapterLike | null | undefined;
  taskId: string;
  now: () => Date;
}

interface LinearTaskSource {
  provider?: string;
  linearIssueId?: string;
  workflowStateId?: string;
  workflowStateName?: string;
}

interface LinearTaskRecordForOutbound {
  status?: string;
  availableActions?: string[];
  source?: LinearTaskSource;
}

const AGENTRAIL_TASK_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);

async function handleGitHubIssueIntake({ request, response, intakeAdapter }: GitHubIssueIntakeOptions) {
  if (!intakeAdapter || typeof intakeAdapter.ingest !== "function") {
    writeError(response, 404, "not_found", "GitHub issue intake is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await intakeAdapter.ingest(
      payload,
      request.headers["idempotency-key"] as string | undefined
    );
    writeJson(response, 201, {
      data: body,
      availableActions: ["get_task"]
    });
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

async function handleLinearIssueIntake({ request, response, linearIntakeAdapter }: LinearIssueIntakeOptions) {
  if (!linearIntakeAdapter || typeof linearIntakeAdapter.ingest !== "function") {
    writeError(response, 404, "not_found", "Linear issue intake is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const body = await linearIntakeAdapter.ingest(
      payload,
      request.headers["idempotency-key"] as string | undefined
    );
    writeJson(response, 201, {
      data: body,
      availableActions: ["get_task"]
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeError(response, 400, "validation_error", "Request body must be valid JSON.", {
        availableActions: ["retry"]
      });
      return;
    }

    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

async function handleLinearIssueImport({ request, response, linearIntakeAdapter }: LinearIssueIntakeOptions) {
  if (!linearIntakeAdapter || typeof linearIntakeAdapter.importIssue !== "function") {
    writeError(response, 404, "not_found", "Linear import is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const payload = await readJsonBody(request) as { selector?: unknown };
    const selector = typeof payload?.selector === "string" ? payload.selector : "";
    const body = await linearIntakeAdapter.importIssue(
      selector,
      request.headers["idempotency-key"] as string | undefined,
    );
    writeJson(response, 201, {
      data: body,
      availableActions: ["get_task"]
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeError(response, 400, "validation_error", "Request body must be valid JSON.", {
        availableActions: ["retry"]
      });
      return;
    }

    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

async function handleCreateLinearTaskComment({
  request,
  response,
  taskLifecycleStore,
  linearIssueSourceAdapter,
  taskId,
  now
}: LinearOutboundOptions) {
  if (!linearIssueSourceAdapter || typeof linearIssueSourceAdapter.createComment !== "function") {
    writeError(response, 404, "not_found", "Linear issue source adapter is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const body = normalizeLinearCommentRequest(payload);
    const { source } = getLinearIssueSource(taskLifecycleStore, taskId);
    const idempotencyStore = getTaskIdempotencyStore(taskLifecycleStore);
    const responseBody = await runIdempotentLinearMutation({
      idempotencyStore,
      keyPrefix: "linear-comment",
      idempotencyKey,
      fingerprintPayload: { taskId, linearIssueId: source.linearIssueId, body },
      mutation: async () => {
        const adapterResult = await linearIssueSourceAdapter.createComment(source.linearIssueId, body);
        const data = recordValue(adapterResult, "data");
        if (data?.success !== true) {
          throw new TaskLifecycleError(502, "upstream_error", "Linear comment creation was not accepted upstream.", {
            availableActions: ["retry"],
          });
        }
        return {
          data: {
            taskId,
            linearIssueId: source.linearIssueId,
            commentId: nullableString(data?.commentId),
            commentUrl: nullableString(data?.commentUrl),
            success: true,
            syncedAt: now().toISOString(),
            availableActions: ["get_task"],
          },
          availableActions: ["get_task"],
        };
      },
    });

    writeJson(response, 201, responseBody);
  } catch (error) {
    writeLinearOutboundError(response, error);
  }
}

async function handleUpdateLinearWorkflowState({
  request,
  response,
  taskLifecycleStore,
  linearIssueSourceAdapter,
  taskId,
  now
}: LinearOutboundOptions) {
  if (!linearIssueSourceAdapter || typeof linearIssueSourceAdapter.updateIssueState !== "function") {
    writeError(response, 404, "not_found", "Linear issue source adapter is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const payload = await readJsonBody(request);
    const syncRequest = normalizeLinearWorkflowStateRequest(payload);
    const { task, source } = getLinearIssueSource(taskLifecycleStore, taskId);
    const idempotencyStore = getTaskIdempotencyStore(taskLifecycleStore);
    const responseBody = await runIdempotentLinearMutation({
      idempotencyStore,
      keyPrefix: "linear-workflow-state",
      idempotencyKey,
      fingerprintPayload: { taskId, linearIssueId: source.linearIssueId, ...syncRequest },
      mutation: async () => {
        const adapterResult = await linearIssueSourceAdapter.updateIssueState(source.linearIssueId, syncRequest.stateId);
        const data = recordValue(adapterResult, "data");
        const issueId = nullableString(data?.issueId);
        if (data?.success !== true || issueId !== source.linearIssueId) {
          throw new TaskLifecycleError(502, "upstream_error", "Linear workflow-state update was not accepted upstream.", {
            availableActions: ["retry"],
          });
        }

        const resolvedStateId = nullableString(data?.stateId) ?? syncRequest.stateId;
        const agentRailStatus = nullableString(data?.agentRailStatus);
        if (!agentRailStatus || !AGENTRAIL_TASK_STATUSES.has(agentRailStatus)) {
          throw new TaskLifecycleError(502, "upstream_error", "Linear workflow-state update did not return a mappable AgentRail status.", {
            availableActions: ["retry"],
          });
        }
        const availableActions = availableActionsForTaskStatus(agentRailStatus);
        updateTaskForLinearWorkflowState(taskLifecycleStore, taskId, {
          status: agentRailStatus,
          availableActions,
          source: {
            ...task.source,
            workflowStateId: resolvedStateId,
            workflowStateName: nullableString(data?.stateName) ?? task.source?.workflowStateName,
          },
        });
        return {
          data: {
            taskId,
            linearIssueId: issueId,
            stateId: resolvedStateId,
            stateName: nullableString(data?.stateName),
            success: true,
            agentRailStatus,
            syncedAt: now().toISOString(),
            availableActions,
          },
          availableActions: ["get_task"],
        };
      },
    });

    writeJson(response, 200, responseBody);
  } catch (error) {
    writeLinearOutboundError(response, error);
  }
}

async function handleLinearWebhook({ request, response, linearIntakeAdapter, linearWebhookAdapter }: LinearWebhookOptions) {
  if (
    (!linearIntakeAdapter || typeof linearIntakeAdapter.receiveWebhook !== "function") &&
    (!linearWebhookAdapter || typeof linearWebhookAdapter.receiveWebhook !== "function")
  ) {
    writeError(response, 404, "not_found", "Linear webhook intake is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  const rawBody = await readRequestBody(request);

  const headers = request.headers as Record<string, string | string[]>;
  const eventType = peekLinearWebhookEventType(rawBody, headers);
  if (eventType === "Comment" && linearWebhookAdapter && typeof linearWebhookAdapter.receiveWebhook === "function") {
    try {
      logNarrative({
        title: "Webhook Received",
        message: "Linear comment delivery received",
        operation: "linear_comment_webhook_receipt",
        provider: "linear",
      });
      const body = await linearWebhookAdapter.receiveWebhook({ headers, rawBody });
      writeJson(response, 200, body);
    } catch (error) {
      if (error instanceof TaskLifecycleError) {
        writeError(response, error.statusCode, error.code, error.message, error.details);
        return;
      }

      throw error;
    }
    return;
  }

  if (!linearIntakeAdapter || typeof linearIntakeAdapter.receiveWebhook !== "function") {
    writeError(response, 404, "not_found", "Linear webhook intake is not configured.", {
      availableActions: ["contact_support"]
    });
    return;
  }

  try {
    logNarrative({
      title: "Webhook Received",
      message: `Linear ${eventType ?? "unknown"} delivery received`,
      operation: "linear_webhook_receipt",
      provider: "linear",
    });
    const body = await linearIntakeAdapter.receiveWebhook({
      headers,
      rawBody
    });
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof TaskLifecycleError) {
      writeError(response, error.statusCode, error.code, error.message, error.details);
      return;
    }

    throw error;
  }
}

function writeLinearOutboundError(response: http.ServerResponse, error: unknown) {
  if (error instanceof SyntaxError) {
    writeError(response, 400, "validation_error", "Request body must be valid JSON.", {
      availableActions: ["retry"]
    });
    return;
  }

  if (error instanceof TaskLifecycleError) {
    writeError(response, error.statusCode, error.code, error.message, error.details);
    return;
  }

  throw error;
}

function normalizeLinearCommentRequest(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.body !== "string" || payload.body.trim().length === 0) {
    throw new TaskLifecycleError(400, "validation_error", "Linear comment payload requires a non-empty `body` string.", {
      availableActions: ["retry"]
    });
  }
  if (payload.body.length > 10000) {
    throw new TaskLifecycleError(400, "validation_error", "Linear comment `body` must be 10000 characters or fewer.", {
      availableActions: ["retry"]
    });
  }
  return payload.body;
}

function normalizeLinearWorkflowStateRequest(payload: unknown): { stateId: string } {
  if (!isRecord(payload) || typeof payload.stateId !== "string" || payload.stateId.trim().length === 0) {
    throw new TaskLifecycleError(400, "validation_error", "Linear workflow-state payload requires a non-empty `stateId` string.", {
      availableActions: ["retry"]
    });
  }
  return {
    stateId: payload.stateId.trim(),
  };
}

function getLinearIssueSource(taskLifecycleStore: unknown, taskId: string): { task: LinearTaskRecordForOutbound; source: { linearIssueId: string } } {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { getRawTask?: unknown }).getRawTask !== "function") {
    throw new TaskLifecycleError(404, "not_found", "Task source not found.", {
      availableActions: ["list_my_tasks"]
    });
  }

  const task = (taskLifecycleStore as { getRawTask: (taskId: string) => LinearTaskRecordForOutbound | null }).getRawTask(taskId);
  if (!task) {
    throw new TaskLifecycleError(404, "not_found", "Task not found.", {
      availableActions: ["list_my_tasks"]
    });
  }
  const source = task.source;
  if (source?.provider !== "linear" || typeof source.linearIssueId !== "string" || source.linearIssueId.trim().length === 0) {
    throw new TaskLifecycleError(404, "not_found", "Linear issue source not found for task.", {
      availableActions: ["repair_task_source"]
    });
  }

  return { task, source: { linearIssueId: source.linearIssueId } };
}

function updateTaskForLinearWorkflowState(
  taskLifecycleStore: unknown,
  taskId: string,
  patch: { status: string; availableActions: string[]; source: LinearTaskRecordForOutbound["source"] }
) {
  if (!taskLifecycleStore || typeof (taskLifecycleStore as { updateTask?: unknown }).updateTask !== "function") {
    return null;
  }
  return (taskLifecycleStore as { updateTask: (taskId: string, patch: unknown) => unknown }).updateTask(taskId, patch);
}

function getTaskIdempotencyStore(taskLifecycleStore: unknown): {
  getIdempotencyEntry: (key: string) => { fingerprint: string; response: unknown } | null;
  setIdempotencyEntry: (key: string, entry: { fingerprint: string; response: unknown }) => void;
} {
  if (
    !taskLifecycleStore ||
    typeof (taskLifecycleStore as { getIdempotencyEntry?: unknown }).getIdempotencyEntry !== "function" ||
    typeof (taskLifecycleStore as { setIdempotencyEntry?: unknown }).setIdempotencyEntry !== "function"
  ) {
    throw new TaskLifecycleError(404, "not_found", "Task source idempotency store is not configured.", {
      availableActions: ["contact_support"]
    });
  }
  return taskLifecycleStore as {
    getIdempotencyEntry: (key: string) => { fingerprint: string; response: unknown } | null;
    setIdempotencyEntry: (key: string, entry: { fingerprint: string; response: unknown }) => void;
  };
}

async function runIdempotentLinearMutation({
  idempotencyStore,
  keyPrefix,
  idempotencyKey,
  fingerprintPayload,
  mutation,
}: {
  idempotencyStore: ReturnType<typeof getTaskIdempotencyStore>;
  keyPrefix: string;
  idempotencyKey: string;
  fingerprintPayload: unknown;
  mutation: () => Promise<unknown>;
}) {
  const storeKey = `${keyPrefix}:${idempotencyKey}`;
  const fingerprint = stableStringify(fingerprintPayload);
  const prior = idempotencyStore.getIdempotencyEntry(storeKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different request payload.", {
        idempotencyKey,
        availableActions: ["retry"]
      });
    }
    return structuredClone(prior.response);
  }

  const responseBody = await mutation();
  idempotencyStore.setIdempotencyEntry(storeKey, { fingerprint, response: structuredClone(responseBody) });
  return responseBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function availableActionsForTaskStatus(status: string): string[] {
  switch (status) {
    case "todo": return ["start"];
    case "in_progress":
    case "blocked":
    case "in_review":
      return ["submit"];
    case "done":
    case "cancelled":
      return [];
    default:
      return ["get_task"];
  }
}

function peekLinearWebhookEventType(rawBody: string, headers: Record<string, string | string[] | undefined>): string | null {
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === "linear-event")?.[1];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === "string" && headerValue.length > 0) return headerValue;
  try {
    const payload = JSON.parse(rawBody) as unknown;
    return isRecord(payload) && typeof payload.type === "string" ? payload.type : null;
  } catch {
    return null;
  }
}

function verifyGitHubWebhook({
  rawBody,
  signatureHeader,
  secret,
}: {
  rawBody: string;
  signatureHeader: string | string[] | undefined;
  secret: string;
}) {
  const provided = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!provided || !provided.startsWith("sha256=")) {
    throw new TaskLifecycleError(401, "github_webhook_unauthorized", "GitHub webhook signature is missing or invalid.", {
      availableActions: ["retry"],
    });
  }
  const expected = `sha256=${createGitHubWebhookDigest(rawBody, secret)}`;
  if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    throw new TaskLifecycleError(401, "github_webhook_unauthorized", "GitHub webhook signature is missing or invalid.", {
      availableActions: ["retry"],
    });
  }
}

function createGitHubWebhookDigest(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function projectMatchedCiTasks({
  taskLifecycleStore,
  ciStatusAdapter,
  matchedTaskIds,
}: {
  taskLifecycleStore: TaskLifecycleStoreLike | null | unknown;
  ciStatusAdapter: { getTaskCiStatus?(taskId: string): Promise<unknown> | unknown } | null;
  matchedTaskIds: string[];
}) {
  const lifecycle = taskLifecycleStore as TaskLifecycleStoreLike | null;
  if (!lifecycle?.projectCiState || !ciStatusAdapter?.getTaskCiStatus) {
    return;
  }
  for (const taskId of matchedTaskIds) {
    try {
      const body = await ciStatusAdapter.getTaskCiStatus(taskId) as any;
      if (!body?.data?.overallStatus) continue;
      const summary = body.data.summary ?? {};
      await lifecycle.projectCiState(taskId, {
        provider: inferCiProviderFromBody(body.data, lifecycle.getRawTask?.(taskId)),
        overallStatus: body.data.overallStatus,
        summary: {
          total: Number(summary.total ?? 0),
          passed: Number(summary.passed ?? 0),
          failed: Number(summary.failed ?? 0),
          running: Number(summary.running ?? 0),
          queued: Number(summary.queued ?? 0),
          cancelled: Number(summary.cancelled ?? 0),
          skipped: Number(summary.skipped ?? 0),
          neutral: Number(summary.neutral ?? 0),
        },
        headline: firstCiHeadline(body.data.failureSummaries),
        updatedAt: body.data.updatedAt ?? null,
      });
    } catch (error) {
      logNarrative({
        title: "CI Sync Warning",
        message: `Failed to project CI status for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        operation: "ci_projection_failed",
        taskId,
      });
    }
  }
}

function matchGitHubWorkflowTasks(taskLifecycleStore: TaskLifecycleStoreLike | null | unknown, payload: Record<string, any>): string[] {
  const lifecycle = taskLifecycleStore as TaskLifecycleStoreLike | null;
  if (!lifecycle?.listRawTasks && !lifecycle?.listRawTasksBySourceRepo) {
    return [];
  }
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name ?? null;
  const repo = payload.repository?.name ?? null;
  const branch = payload.workflow_run?.head_branch ?? null;
  const headSha = payload.workflow_run?.head_sha ?? null;
  const candidates = owner && repo && lifecycle?.listRawTasksBySourceRepo
    ? lifecycle.listRawTasksBySourceRepo("github", owner, repo)
    : lifecycle?.listRawTasks?.() ?? [];
  const matched: string[] = [];
  for (const task of candidates) {
    const source = task.source;
    if (!source) continue;
    if (source.provider !== "github") continue;
    if (owner && source.owner !== owner) continue;
    if (repo && source.repo !== repo) continue;
    const matchesHeadSha = Boolean(headSha && source.headSha && source.headSha === headSha);
    const matchesBranch = Boolean(branch && source.branch && source.branch === branch);
    if (!matchesHeadSha && !matchesBranch) continue;
    matched.push(task.id);
  }
  return matched;
}

function inferCiProviderFromBody(data: Record<string, any>, task: any): string {
  if (typeof task?.source?.ciProvider === "string") {
    return task.source.ciProvider;
  }
  if (task?.source?.provider === "github") {
    return "github_actions";
  }
  return data.provider ?? task?.source?.provider ?? "github_actions";
}

function firstCiHeadline(failureSummaries: unknown): string | null {
  if (!Array.isArray(failureSummaries) || failureSummaries.length === 0) return null;
  const first = failureSummaries[0] as Record<string, unknown>;
  if (typeof first.message === "string" && first.message.length > 0) return first.message;
  if (typeof first.testName === "string" && first.testName.length > 0) return first.testName;
  return null;
}

function describeWebhookReceipt(provider: string, body: unknown): string {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const data = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : {};
  const matchedTasks = Array.isArray(data.matchedTasks) ? data.matchedTasks.length : 0;
  const deduplicated = data.deduplicated === true;
  const ignored = data.ignored === true;
  if (deduplicated) {
    return `${provider} delivery was deduplicated`;
  }
  if (ignored) {
    return `${provider} delivery was accepted and ignored with ${matchedTasks} matched ${matchedTasks === 1 ? "task" : "tasks"}`;
  }
  return `${provider} delivery matched ${matchedTasks} ${matchedTasks === 1 ? "task" : "tasks"}`;
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

import fs from "node:fs";

import { createServer } from "./app.ts";
import { AgentAuthStore } from "./agent-auth-store.ts";
import { CircleCiStatusAdapter } from "./circleci-status-adapter.ts";
import { GitHubActionsCiAdapter } from "./github-actions-ci-adapter.ts";
import { GitHubReviewFeedbackAdapter } from "./github-review-feedback-adapter.ts";
import { GitHubRollbackAdapter } from "./github-rollback-adapter.ts";
import { GitHubSubmitAdapter } from "./github-submit-adapter.ts";
import { MultiCiStatusAdapter } from "./multi-ci-status-adapter.ts";
import { TaskEventStore } from "./task-event-store.ts";
import { AgentTaskQueue } from "./agent-task-queue.ts";
import { GitHubIssueIntakeAdapter } from "./github-issue-intake-adapter.ts";
import { AgentProfileStore } from "./agent-profile-store.ts";
import { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { RoutingAuditStore } from "./routing-audit-store.ts";
import { RoutingRuleStore } from "./routing-rule-store.ts";

loadDotEnv();

const host = process.env.AGENTRAIL_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.AGENTRAIL_PORT || process.env.PORT || "3000", 10);
const publicBaseUrl =
  process.env.AGENTRAIL_PUBLIC_BASE_URL || `http://${host}:${port}`;
const storagePath = process.env.AGENTRAIL_EVENT_STORE_PATH || undefined;

const fallbackMode = (process.env.AGENTRAIL_FALLBACK_MODE ?? "false").toLowerCase() === "true";

const now = () => new Date();
const eventStore = new TaskEventStore({ now, storagePath });

const githubToken = process.env.GITHUB_TOKEN || null;
const circleciToken = process.env.CIRCLECI_TOKEN || null;
const taskSourcesJson = process.env.AGENTRAIL_TASK_SOURCES || null;

let server: ReturnType<typeof createServer> | null = null;

try {
  const runtime = buildRuntime({
    taskSourcesJson,
    githubToken,
    circleciToken,
    now,
    eventStore,
    publicBaseUrl
  });

  const authStore = new AgentAuthStore({ now });

  server = createServer({
    store: eventStore,
    taskLifecycleStore: runtime.taskLifecycleStore,
    ciStatusAdapter: runtime.ciStatusAdapter,
    reviewFeedbackAdapter: runtime.reviewFeedbackAdapter,
    rollbackAdapter: runtime.rollbackAdapter,
    intakeAdapter: runtime.intakeAdapter,
    routingControlPlane: runtime.routingControlPlane,
    authStore,
    now,
    publicBaseUrl,
    fallbackMode,
  });

  server.listen(port, host, () => {
    process.stdout.write(`AgentRail API listening on ${publicBaseUrl}\n`);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentRail startup failed: ${message}\n`);
  process.exit(1);
}

function shutdown() {
  server?.close(() => {
    process.exit(0);
  });
}

function loadDotEnv() {
  try {
    const content = readFileIfExists(".env");
    if (!content) return;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = stripQuotes(value);
      }
    }
  } catch {
    // .env loading is convenience-only; environment variables still work.
  }
}

function readFileIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function buildRuntime({
  taskSourcesJson,
  githubToken,
  circleciToken,
  now,
  eventStore,
  publicBaseUrl
}: {
  taskSourcesJson: string | null;
  githubToken: string | null;
  circleciToken: string | null;
  now: () => Date;
  eventStore: TaskEventStore;
  publicBaseUrl: string;
}) {
  const taskSources = parseTaskSources(taskSourcesJson);
  if (!githubToken) {
    throw new Error(
      "GITHUB_TOKEN is required for GitHub-backed submit, review, and CI adapters."
    );
  }

  const taskStorePath = process.env.AGENTRAIL_TASK_STORE_PATH || undefined;
  const agentProfileStorePath = process.env.AGENTRAIL_AGENT_PROFILES_STORE_PATH || undefined;
  const routingRuleStorePath = process.env.AGENTRAIL_ROUTING_RULES_STORE_PATH || undefined;
  const routingAuditStorePath = process.env.AGENTRAIL_ROUTING_AUDIT_STORE_PATH || undefined;
  let agentQueue: AgentTaskQueue;
  const submitAdapter = new GitHubSubmitAdapter({
    taskSources,
    githubToken,
    apiBaseUrl: publicBaseUrl,
    getTask: (taskId: string) => agentQueue.getRawTask(taskId),
  });

  agentQueue = new AgentTaskQueue({
    now,
    storagePath: taskStorePath,
    eventStore,
    apiBaseUrl: publicBaseUrl,
    delegate: {
      submitTask: (taskId, payload, idempotencyKey) =>
        submitAdapter.submitTask(taskId, payload, idempotencyKey),
    },
  });
  const routingControlPlane = new RoutingControlPlane({
    now,
    taskQueue: agentQueue,
    routingAuditStore: new RoutingAuditStore({
      storagePath: routingAuditStorePath,
    }),
    agentProfileStore: new AgentProfileStore({
      now,
      storagePath: agentProfileStorePath,
    }),
    routingRuleStore: new RoutingRuleStore({
      now,
      storagePath: routingRuleStorePath,
    }),
  });

  return {
    taskLifecycleStore: agentQueue,
    ciStatusAdapter: buildCiStatusAdapter({
      taskSources,
      githubToken,
      circleciToken,
      getTask: (taskId) => agentQueue.getRawTask(taskId),
    }),
    reviewFeedbackAdapter: new GitHubReviewFeedbackAdapter({
      taskSources,
      githubToken,
      getTask: (taskId) => agentQueue.getRawTask(taskId),
    }),
    rollbackAdapter: new GitHubRollbackAdapter({
      taskSources,
      githubToken,
      getTask: (taskId) => agentQueue.getRawTask(taskId),
    }),
    intakeAdapter: new GitHubIssueIntakeAdapter({ taskQueue: agentQueue }),
    routingControlPlane,
  };
}

function parseTaskSources(taskSourcesJson: string | null): Map<string, unknown> {
  if (!taskSourcesJson) {
    throw new Error("AGENTRAIL_TASK_SOURCES is required and must be a JSON object keyed by task id.");
  }

  try {
    const parsed = JSON.parse(taskSourcesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }

    return new Map(Object.entries(parsed));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AGENTRAIL_TASK_SOURCES must be a JSON object keyed by task id: ${message}`);
  }
}

function buildCiStatusAdapter({ taskSources, githubToken, circleciToken, getTask }: {
  taskSources: Map<string, unknown> | null;
  githubToken: string | null;
  circleciToken: string | null;
  getTask?: ((taskId: string) => unknown) | null;
}) {
  const adapters = [];

  if (taskSources && githubToken) {
    adapters.push(
      new GitHubActionsCiAdapter({
        taskSources,
        githubToken,
        getTask: getTask as ((taskId: string) => any) ?? null,
      })
    );
  }

  if (taskSources && circleciToken) {
    adapters.push(
      new CircleCiStatusAdapter({
        taskSources,
        circleciToken,
        getTask: getTask as ((taskId: string) => any) ?? null,
      })
    );
  }

  if (adapters.length === 0) {
    return null;
  }

  return new MultiCiStatusAdapter({
    adapters
  });
}

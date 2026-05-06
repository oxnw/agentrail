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

export function buildRuntime({
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
  const hasGitHubRuntime = Boolean(taskSources && githubToken);

  const taskStorePath = process.env.AGENTRAIL_TASK_STORE_PATH || undefined;
  const agentProfileStorePath = process.env.AGENTRAIL_AGENT_PROFILES_STORE_PATH || undefined;
  const routingRuleStorePath = process.env.AGENTRAIL_ROUTING_RULES_STORE_PATH || undefined;
  const routingAuditStorePath = process.env.AGENTRAIL_ROUTING_AUDIT_STORE_PATH || undefined;
  let agentQueue: AgentTaskQueue;
  const submitAdapter = hasGitHubRuntime
    ? new GitHubSubmitAdapter({
        taskSources: taskSources!,
        githubToken: githubToken!,
        apiBaseUrl: publicBaseUrl,
        getTask: (taskId: string) => agentQueue.getRawTask(taskId),
      })
    : null;

  agentQueue = new AgentTaskQueue({
    now,
    storagePath: taskStorePath,
    eventStore,
    apiBaseUrl: publicBaseUrl,
    delegate: submitAdapter
      ? {
          submitTask: (taskId, payload, idempotencyKey) =>
            submitAdapter.submitTask(taskId, payload, idempotencyKey),
        }
      : null,
  });
  const routingAuditStore = new RoutingAuditStore({
    storagePath: routingAuditStorePath,
  });
  const agentProfileStore = new AgentProfileStore({
    now,
    storagePath: agentProfileStorePath,
  });
  const routingRuleStore = new RoutingRuleStore({
    now,
    storagePath: routingRuleStorePath,
  });
  const routingControlPlane = new RoutingControlPlane({
    now,
    taskQueue: agentQueue,
    routingAuditStore,
    agentProfileStore,
    routingRuleStore,
  });

  return {
    taskLifecycleStore: agentQueue,
    ciStatusAdapter: buildCiStatusAdapter({
      taskSources,
      githubToken,
      circleciToken,
      getTask: (taskId) => agentQueue.getRawTask(taskId),
    }),
    reviewFeedbackAdapter: hasGitHubRuntime
      ? new GitHubReviewFeedbackAdapter({
          taskSources: taskSources!,
          githubToken: githubToken!,
          getTask: (taskId) => agentQueue.getRawTask(taskId),
        })
      : null,
    rollbackAdapter: hasGitHubRuntime
      ? new GitHubRollbackAdapter({
          taskSources: taskSources!,
          githubToken: githubToken!,
          getTask: (taskId) => agentQueue.getRawTask(taskId),
        })
      : null,
    intakeAdapter: new GitHubIssueIntakeAdapter({ taskQueue: agentQueue }),
    routingControlPlane,
  };
}

export function parseTaskSources(taskSourcesJson: string | null): Map<string, unknown> | null {
  if (!taskSourcesJson) {
    return null;
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

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
  githubToken,
  circleciToken,
  now,
  eventStore,
  publicBaseUrl
}: {
  githubToken: string | null;
  circleciToken: string | null;
  now: () => Date;
  eventStore: TaskEventStore;
  publicBaseUrl: string;
}) {
  const hasGitHubRuntime = Boolean(githubToken);

  const taskStorePath = process.env.AGENTRAIL_TASK_STORE_PATH || undefined;
  const agentProfileStorePath = process.env.AGENTRAIL_AGENT_PROFILES_STORE_PATH || undefined;
  const routingRuleStorePath = process.env.AGENTRAIL_ROUTING_RULES_STORE_PATH || undefined;
  const routingAuditStorePath = process.env.AGENTRAIL_ROUTING_AUDIT_STORE_PATH || undefined;
  let agentQueue: AgentTaskQueue;
  const submitAdapter = hasGitHubRuntime
    ? new GitHubSubmitAdapter({
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
      githubToken,
      circleciToken,
      getTask: (taskId) => agentQueue.getRawTask(taskId),
      listTasks: () => agentQueue.listRawTasks(),
    }),
    reviewFeedbackAdapter: hasGitHubRuntime
      ? new GitHubReviewFeedbackAdapter({
          githubToken: githubToken!,
          getTask: (taskId) => agentQueue.getRawTask(taskId),
        })
      : null,
    rollbackAdapter: hasGitHubRuntime
      ? new GitHubRollbackAdapter({
          githubToken: githubToken!,
          getTask: (taskId) => agentQueue.getRawTask(taskId),
        })
      : null,
    intakeAdapter: new GitHubIssueIntakeAdapter({ taskQueue: agentQueue }),
    routingControlPlane,
  };
}

function buildCiStatusAdapter({ githubToken, circleciToken, getTask, listTasks }: {
  githubToken: string | null;
  circleciToken: string | null;
  getTask?: ((taskId: string) => unknown) | null;
  listTasks?: (() => unknown[]) | null;
}) {
  const adapters = [];

  if (githubToken) {
    adapters.push(
      new GitHubActionsCiAdapter({
        githubToken,
        getTask: getTask as ((taskId: string) => any) ?? null,
      })
    );
  }

  if (circleciToken) {
    adapters.push(
      new CircleCiStatusAdapter({
        circleciToken,
        getTask: getTask as ((taskId: string) => any) ?? null,
        listTasks: listTasks as (() => any[]) ?? null,
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

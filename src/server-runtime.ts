import { CircleCiStatusAdapter } from "./circleci-status-adapter.ts";
import { GitHubActionsCiAdapter } from "./github-actions-ci-adapter.ts";
import { GitHubReviewFeedbackAdapter } from "./github-review-feedback-adapter.ts";
import { GitHubRollbackAdapter } from "./github-rollback-adapter.ts";
import { GitHubSubmitAdapter } from "./github-submit-adapter.ts";
import { MultiCiStatusAdapter } from "./multi-ci-status-adapter.ts";
import { TaskEventStore } from "./task-event-store.ts";
import { AgentTaskQueue } from "./agent-task-queue.ts";
import { GitHubIssueIntakeAdapter } from "./github-issue-intake-adapter.ts";
import { LinearIssueSourceAdapter } from "./linear-issue-source-adapter.ts";
import { LinearCommentWebhookAdapter } from "./linear-comment-webhook-adapter.ts";
import { AgentProfileStore } from "./agent-profile-store.ts";
import { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { RoutingAuditStore } from "./routing-audit-store.ts";
import { RoutingRuleStore } from "./routing-rule-store.ts";
import { ProviderCursorStore } from "./provider-cursor-store.ts";
import type { ConnectedRepo } from "./cli/agentrail-home.ts";
import { logNarrative, logOperatorNotice } from "./structured-logger.ts";
import type { TaskRecord } from "./task-store.ts";

export type GitHubIssueImportMode = "from_now" | "backfill";

type LinearIssueRuntimeAdapter = Pick<LinearIssueSourceAdapter, "ingest" | "createComment" | "updateIssueState" | "importIssue" | "refreshIssue"> & {
  receiveWebhook?: LinearIssueSourceAdapter["receiveWebhook"];
};

type DeliveryController = {
  start(): void;
  stop(): Promise<void>;
};

type PollSummary = {
  provider: "GitHub" | "Linear" | "CircleCI" | "GitHub Actions";
  scope: string;
  checked: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  ciFailed: number;
  ciRecovered: number;
  notable: string[];
};

export function buildRuntime({
  githubToken,
  githubMode = "disabled",
  githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || null,
  githubDeliveryMode = "polling",
  githubIssueImportMode = "from_now",
  githubPollIntervalMs = null,
  circleciToken,
  circleciMode = "disabled",
  circleciWebhookSecret = process.env.CIRCLECI_WEBHOOK_SECRET || null,
  circleciDeliveryMode = "polling",
  circleciPollIntervalMs = null,
  linearApiKey = process.env.LINEAR_API_KEY || null,
  linearMode = "disabled",
  linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET || null,
  linearDeliveryMode = "polling",
  linearPollIntervalMs = null,
  enableBackgroundDelivery = true,
  repos = [],
  now,
  eventStore,
  publicBaseUrl
}: {
  githubToken: string | null;
  githubMode?: "real" | "disabled";
  githubWebhookSecret?: string | null;
  githubDeliveryMode?: "polling" | "webhook";
  githubIssueImportMode?: GitHubIssueImportMode;
  githubPollIntervalMs?: number | null;
  circleciToken: string | null;
  circleciMode?: "real" | "disabled";
  circleciWebhookSecret?: string | null;
  circleciDeliveryMode?: "polling" | "webhook";
  circleciPollIntervalMs?: number | null;
  linearApiKey?: string | null;
  linearMode?: "real" | "disabled";
  linearWebhookSecret?: string | null;
  linearDeliveryMode?: "polling" | "webhook";
  linearPollIntervalMs?: number | null;
  enableBackgroundDelivery?: boolean;
  repos?: ConnectedRepo[];
  now: () => Date;
  eventStore: TaskEventStore;
  publicBaseUrl: string;
}) {
  const hasGitHubRuntime = Boolean(githubToken);

  const taskStorePath = process.env.AGENTRAIL_TASK_STORE_PATH || undefined;
  const agentProfileStorePath = process.env.AGENTRAIL_AGENT_PROFILES_STORE_PATH || undefined;
  const routingRuleStorePath = process.env.AGENTRAIL_ROUTING_RULES_STORE_PATH || undefined;
  const routingAuditStorePath = process.env.AGENTRAIL_ROUTING_AUDIT_STORE_PATH || undefined;
  const providerCursorStorePath = process.env.AGENTRAIL_PROVIDER_CURSOR_STORE_PATH || undefined;
  let agentQueue: AgentTaskQueue;
  const submitAdapter = hasGitHubRuntime
    ? new GitHubSubmitAdapter({
        githubToken: githubToken!,
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
  const providerCursorStore = new ProviderCursorStore({
    now,
    storagePath: providerCursorStorePath,
  });
  const routingControlPlane = new RoutingControlPlane({
    now,
    taskQueue: agentQueue,
    routingAuditStore,
    agentProfileStore,
    routingRuleStore,
  });
  const githubIssueIntakeAdapter = new GitHubIssueIntakeAdapter({
    taskQueue: agentQueue,
    routingControlPlane,
    routingMode: "required",
    repos,
    now,
  });
  const linearIssueSourceAdapter = new LinearIssueSourceAdapter({
    taskQueue: agentQueue,
    routingControlPlane,
    routingMode: "required",
    linearApiKey,
    webhookSecret: linearWebhookSecret,
    now,
  });
  const linearIntakeAdapter = buildLinearIssueRuntimeAdapter(linearIssueSourceAdapter, linearWebhookSecret);
  const { ciStatusAdapter, githubActionsCiAdapter, circleCiStatusAdapter } = buildCiStatusAdapter({
    githubToken,
    circleciToken,
    circleciWebhookSecret,
    getTask: (taskId) => agentQueue.getRawTask(taskId),
    listTasks: () => agentQueue.listRawTasks(),
  });
  const deliveryController = enableBackgroundDelivery
    ? buildDeliveryController({
      now,
      taskQueue: agentQueue,
      ciStatusAdapter,
      intakeAdapter: githubIssueIntakeAdapter,
      linearIssueSourceAdapter,
      githubToken,
      githubMode,
      githubDeliveryMode,
      githubIssueImportMode,
      githubPollIntervalMs,
      providerCursorStore,
      circleciToken,
      circleciMode,
      circleciDeliveryMode,
      circleciPollIntervalMs,
      linearApiKey,
      linearMode,
      linearDeliveryMode,
      linearPollIntervalMs,
      repos,
    })
    : null;

  return {
    taskLifecycleStore: agentQueue,
    ciStatusAdapter,
    githubActionsCiAdapter,
    circleCiStatusAdapter,
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
    intakeAdapter: githubIssueIntakeAdapter,
    linearIntakeAdapter,
    linearWebhookAdapter: linearWebhookSecret
      ? new LinearCommentWebhookAdapter({
          taskQueue: agentQueue,
          eventStore,
          now,
          apiBaseUrl: publicBaseUrl,
          webhookSecret: linearWebhookSecret,
        })
      : null,
    deliveryController,
    routingControlPlane,
  };
}

function buildCiStatusAdapter({ githubToken, circleciToken, circleciWebhookSecret, getTask, listTasks }: {
  githubToken: string | null;
  circleciToken: string | null;
  circleciWebhookSecret: string | null;
  getTask?: ((taskId: string) => TaskRecord | null) | null;
  listTasks?: (() => TaskRecord[]) | null;
}) {
  const adapters = [];
  const githubActionsCiAdapter = githubToken
    ? new GitHubActionsCiAdapter({
      githubToken,
      getTask: getTask ?? null,
    })
    : null;
  const circleCiStatusAdapter = circleciToken
    ? new CircleCiStatusAdapter({
      circleciToken,
      webhookSecret: circleciWebhookSecret,
      getTask: getTask ?? null,
      listTasks: listTasks ?? null,
    })
    : null;

  if (githubActionsCiAdapter) {
    adapters.push(githubActionsCiAdapter);
  }

  if (circleCiStatusAdapter) {
    adapters.push(circleCiStatusAdapter);
  }

  if (adapters.length === 0) {
    return {
      ciStatusAdapter: null,
      githubActionsCiAdapter: null,
      circleCiStatusAdapter: null,
    };
  }

  return {
    ciStatusAdapter: new MultiCiStatusAdapter({
      adapters
    }),
    githubActionsCiAdapter,
    circleCiStatusAdapter,
  };
}

function buildLinearIssueRuntimeAdapter(
  linearIssueSourceAdapter: LinearIssueSourceAdapter,
  linearWebhookSecret: string | null,
): LinearIssueRuntimeAdapter {
  if (linearWebhookSecret) {
    return linearIssueSourceAdapter;
  }

  return {
    ingest: linearIssueSourceAdapter.ingest.bind(linearIssueSourceAdapter),
    importIssue: linearIssueSourceAdapter.importIssue.bind(linearIssueSourceAdapter),
    refreshIssue: linearIssueSourceAdapter.refreshIssue.bind(linearIssueSourceAdapter),
    createComment: linearIssueSourceAdapter.createComment.bind(linearIssueSourceAdapter),
    updateIssueState: linearIssueSourceAdapter.updateIssueState.bind(linearIssueSourceAdapter),
  };
}

function buildDeliveryController({
  now,
  taskQueue,
  ciStatusAdapter,
  intakeAdapter,
  linearIssueSourceAdapter,
  githubToken,
  githubMode,
  githubDeliveryMode,
  githubIssueImportMode,
  githubPollIntervalMs,
  providerCursorStore,
  circleciToken,
  circleciMode,
  circleciDeliveryMode,
  circleciPollIntervalMs,
  linearApiKey,
  linearMode,
  linearDeliveryMode,
  linearPollIntervalMs,
  repos,
}: {
  now: () => Date;
  taskQueue: AgentTaskQueue;
  ciStatusAdapter: { getTaskCiStatus?(taskId: string): Promise<any> | any } | null;
  intakeAdapter: GitHubIssueIntakeAdapter;
  linearIssueSourceAdapter: LinearIssueSourceAdapter;
  githubToken: string | null;
  githubMode: "real" | "disabled";
  githubDeliveryMode: "polling" | "webhook";
  githubIssueImportMode: GitHubIssueImportMode;
  githubPollIntervalMs: number | null;
  providerCursorStore: ProviderCursorStore;
  circleciToken: string | null;
  circleciMode: "real" | "disabled";
  circleciDeliveryMode: "polling" | "webhook";
  circleciPollIntervalMs: number | null;
  linearApiKey: string | null;
  linearMode: "real" | "disabled";
  linearDeliveryMode: "polling" | "webhook";
  linearPollIntervalMs: number | null;
  repos: ConnectedRepo[];
}): DeliveryController | null {
  const schedules = [];
  if (githubMode === "real" && githubToken && githubDeliveryMode === "polling") {
    schedules.push({
      provider: "GitHub",
      description: `GitHub will poll ${repos.length === 1 ? repos[0]?.slug ?? "configured repositories" : `${repos.length} repositories`} every ${formatInterval(normalizeInterval(githubPollIntervalMs))}`,
      intervalMs: normalizeInterval(githubPollIntervalMs),
      run: async () => {
        const summaries: PollSummary[] = [];
        for (const repo of repos) {
          summaries.push(await pollGitHubIssues({
            token: githubToken,
            repo,
            intakeAdapter,
            cursorStore: providerCursorStore,
            importMode: githubIssueImportMode,
            now,
          }));
        }
        summaries.push(await projectCiStates({
          taskQueue,
          ciStatusAdapter,
          filter: (task) => task.source?.provider === "github" || task.source?.ciProvider === "github_actions",
          provider: "GitHub Actions",
          scope: "active GitHub-backed tasks",
        }));
        logPollSummaries(summaries);
      },
    });
  }
  if (circleciMode === "real" && circleciToken && circleciDeliveryMode === "polling") {
    schedules.push({
      provider: "CircleCI",
      description: `CircleCI will poll matching task CI every ${formatInterval(normalizeInterval(circleciPollIntervalMs))}`,
      intervalMs: normalizeInterval(circleciPollIntervalMs),
      run: async () => {
        logPollSummaries([await projectCiStates({
          taskQueue,
          ciStatusAdapter,
          filter: (task) => task.source?.ciProvider === "circleci",
          provider: "CircleCI",
          scope: "active CircleCI-backed tasks",
        })]);
      },
    });
  }
  if (linearMode === "real" && linearApiKey && linearDeliveryMode === "polling") {
    schedules.push({
      provider: "Linear",
      description: `Linear will poll workspace issues every ${formatInterval(normalizeInterval(linearPollIntervalMs))}`,
      intervalMs: normalizeInterval(linearPollIntervalMs),
      run: async () => {
        logPollSummaries([await pollLinearIssues({ token: linearApiKey, linearIssueSourceAdapter, now })]);
      },
    });
  }
  if (schedules.length === 0) {
    return null;
  }

  const states = schedules.map((schedule) => ({
    ...schedule,
    timer: null as NodeJS.Timeout | null,
    runningPromise: null as Promise<void> | null,
  }));

  return {
    start() {
      for (const state of states) {
        logOperatorNotice({
          title: String(state.provider),
          message: state.description.replace(/^[^ ]+ will /u, "polling "),
        });
        logNarrative({
          title: "Delivery Mode",
          message: state.description,
          operation: "delivery_mode",
          provider: String(state.provider).toLowerCase(),
        });
      }
      for (const state of states) {
        if (state.timer) continue;
        state.timer = setInterval(() => {
          void runSchedule(state);
        }, state.intervalMs);
        void runSchedule(state);
      }
    },
    async stop() {
      for (const state of states) {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      }
      const inFlight = states
        .map(state => state.runningPromise)
        .filter((promise): promise is Promise<void> => promise !== null);
      if (inFlight.length > 0) {
        await Promise.allSettled(inFlight);
      }
    },
  };
}

function normalizeInterval(value: number | null): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 60_000;
}

async function runSchedule(state: {
  runningPromise: Promise<void> | null;
  provider?: string;
  run(): Promise<void>;
}) {
  if (state.runningPromise) return state.runningPromise;
  const runPromise = (async () => {
    try {
      await state.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logNarrative({
        title: "Poll Failed",
        message: `${state.provider ?? "Provider"} delivery encountered an error: ${message}`,
        operation: "delivery_poll_failed",
        provider: typeof state.provider === "string" ? state.provider.toLowerCase() : undefined,
      });
    }
  })();
  state.runningPromise = runPromise;
  try {
    await runPromise;
  } finally {
    if (state.runningPromise === runPromise) {
      state.runningPromise = null;
    }
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) {
          await worker(item);
        }
      }
    },
  );
  await Promise.all(workers);
}

export async function pollGitHubIssues({
  token,
  repo,
  intakeAdapter,
  cursorStore,
  importMode = "from_now",
  now = () => new Date(),
}: {
  token: string;
  repo: ConnectedRepo;
  intakeAdapter: GitHubIssueIntakeAdapter;
  cursorStore: ProviderCursorStore;
  importMode?: GitHubIssueImportMode;
  now?: () => Date;
}): Promise<PollSummary> {
  const summary = createPollSummary("GitHub", repo.slug);
  const [owner, name] = repo.slug.split("/");
  if (!owner || !name) {
    summary.skipped += 1;
    return summary;
  }
  const cursorKey = { provider: "github" as const, resource: "issues" as const, repository: repo.slug };
  const pollStartedAt = now().toISOString();
  let since = cursorStore.getCursor(cursorKey);
  if (!since && importMode === "from_now") {
    since = pollStartedAt;
    cursorStore.setCursor(cursorKey, since);
  }

  const issues = await fetchAllGitHubIssues({ owner, repo: name, token, repoSlug: repo.slug, since });
  let nextCursor = since ?? pollStartedAt;
  let hadIngestFailure = false;
  for (const issue of issues) {
    if (typeof issue?.updated_at === "string" && issue.updated_at > nextCursor) {
      nextCursor = issue.updated_at;
    }
    if (issue?.pull_request) {
      summary.skipped += 1;
      continue;
    }
    summary.checked += 1;
    try {
      const result = await intakeAdapter.ingest({
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        issueTitle: issue.title,
        body: issue.body ?? "",
        labels: Array.isArray(issue.labels) ? issue.labels.map((label: any) => typeof label === "string" ? label : label?.name).filter(Boolean) : [],
        state: issue.state,
        repository: { owner, repo: name },
        assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
      }, issue.updated_at ?? undefined);
      applyIssueOutcome(summary, result.outcome ?? "updated");
      if (result.outcome === "created" || result.outcome === "updated") {
        summary.notable.push(formatIssueNarrative({
          provider: "GitHub",
          identifier: `${repo.slug}#${issue.number}`,
          outcome: result.outcome,
          routing: result.routing,
        }));
      }
    } catch (error) {
      hadIngestFailure = true;
      summary.failed += 1;
      summary.notable.push(`Failed to process GitHub issue ${repo.slug}#${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!hadIngestFailure) {
    cursorStore.setCursor(cursorKey, nextCursor);
  }
  return summary;
}

async function pollLinearIssues({
  token,
  linearIssueSourceAdapter,
  now,
}: {
  token: string;
  linearIssueSourceAdapter: LinearIssueSourceAdapter;
  now: () => Date;
}): Promise<PollSummary> {
  const summary = createPollSummary("Linear", "workspace issues");
  const issues = await fetchAllLinearIssues(token);
  for (const issue of issues) {
    summary.checked += 1;
    try {
      const result = await linearIssueSourceAdapter.ingest(issue, issue.updatedAt ?? `${now().toISOString()}:linear-poll`);
      applyIssueOutcome(summary, result.outcome ?? "updated");
      const displayIdentifier = typeof issue?.identifier === "string" && issue.identifier.length > 0 ? issue.identifier : result.identifier;
      if (result.outcome === "created" || result.outcome === "updated") {
        summary.notable.push(formatIssueNarrative({
          provider: "Linear",
          identifier: displayIdentifier,
          outcome: result.outcome,
          routing: result.routing,
        }));
      }
    } catch (error) {
      summary.failed += 1;
      summary.notable.push(`Failed to process Linear issue ${issue?.identifier ?? issue?.id ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}

export async function fetchAllGitHubIssues({
  owner,
  repo,
  token,
  repoSlug,
  since,
}: {
  owner: string;
  repo: string;
  token: string;
  repoSlug: string;
  since?: string | null;
}): Promise<Array<any>> {
  const issues: Array<any> = [];
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const params = new URLSearchParams({
    state: "all",
    per_page: "100",
  });
  if (since) {
    params.set("since", since);
  }
  let nextUrl: string | null = `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/issues?${params.toString()}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issue polling failed for ${repoSlug}: ${response.status}`);
    }
    issues.push(...await response.json() as Array<any>);
    nextUrl = parseNextLink(response.headers.get("link"));
  }

  return issues;
}

export async function fetchAllLinearIssues(token: string): Promise<Array<any>> {
  const issues: Array<any> = [];
  let cursor: string | null = null;

  while (true) {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: token,
      },
      body: JSON.stringify({
        query: `query AgentRailPollLinearIssues($after: String) {
          issues(first: 100, after: $after) {
            nodes {
              id
              identifier
              title
              description
              url
              priority
              priorityLabel
              updatedAt
              state { id name type }
              team { id key name }
              assignee { id name }
              labels { nodes { name } }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
        variables: {
          after: cursor,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Linear issue polling failed: ${response.status}`);
    }
    const body = await response.json() as any;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const firstMessage = typeof body.errors[0]?.message === "string" ? body.errors[0].message : "unknown GraphQL error";
      throw new Error(`Linear issue polling failed: ${response.status} ${firstMessage}`);
    }
    const connection = body?.data?.issues;
    issues.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = typeof connection.pageInfo.endCursor === "string" ? connection.pageInfo.endCursor : null;
    if (!cursor) {
      break;
    }
  }

  return issues;
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const match = trimmed.match(/^<([^>]+)>;\s*rel="([^"]+)"$/u);
    if (match && match[2] === "next") {
      return match[1] ?? null;
    }
  }
  return null;
}

async function projectCiStates({
  taskQueue,
  ciStatusAdapter,
  filter,
  provider,
  scope,
}: {
  taskQueue: AgentTaskQueue;
  ciStatusAdapter: { getTaskCiStatus?(taskId: string): Promise<any> | any } | null;
  filter(task: ReturnType<AgentTaskQueue["listRawTasks"]>[number]): boolean;
  provider: "GitHub Actions" | "CircleCI";
  scope: string;
}): Promise<PollSummary> {
  const cycle = createPollSummary(provider, scope);
  if (!ciStatusAdapter?.getTaskCiStatus) {
    return cycle;
  }
  const tasks = taskQueue.listRawTasks().filter(filter);
  cycle.checked += tasks.length;
  await mapWithConcurrency(tasks, 5, async (task) => {
    try {
      const body = await ciStatusAdapter.getTaskCiStatus!(task.id);
      if (!body?.data?.overallStatus) {
        cycle.skipped += 1;
        return;
      }
      const statusSummary = body.data.summary ?? {};
      const headline = firstFailureHeadline(body.data.failureSummaries);
      const projection = await taskQueue.projectCiState(task.id, {
        provider: inferCiProvider(task, body.data),
        overallStatus: body.data.overallStatus,
        summary: {
          total: Number(statusSummary.total ?? 0),
          passed: Number(statusSummary.passed ?? 0),
          failed: Number(statusSummary.failed ?? 0),
          running: Number(statusSummary.running ?? 0),
          queued: Number(statusSummary.queued ?? 0),
          cancelled: Number(statusSummary.cancelled ?? 0),
          skipped: Number(statusSummary.skipped ?? 0),
          neutral: Number(statusSummary.neutral ?? 0),
        },
        headline,
        updatedAt: body.data.updatedAt ?? null,
      });
      if (!projection) {
        return;
      }
      if (projection.outcome === "failed_transition") {
        cycle.ciFailed += 1;
      } else if (projection.outcome === "recovered_transition") {
        cycle.ciRecovered += 1;
      } else {
        cycle.unchanged += 1;
      }
    } catch (error) {
      cycle.failed += 1;
      cycle.notable.push(`Failed to project ${provider} CI for ${task.identifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return cycle;
}

function firstFailureHeadline(failureSummaries: unknown): string | null {
  if (!Array.isArray(failureSummaries) || failureSummaries.length === 0) {
    return null;
  }
  const first = failureSummaries[0] as Record<string, unknown>;
  return typeof first?.message === "string"
    ? first.message
    : typeof first?.testName === "string"
      ? first.testName
      : null;
}

function inferCiProvider(task: ReturnType<AgentTaskQueue["listRawTasks"]>[number], data: Record<string, unknown>): string {
  return typeof task.source?.ciProvider === "string"
    ? task.source.ciProvider
    : typeof data.provider === "string"
      ? String(data.provider)
      : "github_actions";
}

function createPollSummary(provider: PollSummary["provider"], scope: string): PollSummary {
  return {
    provider,
    scope,
    checked: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    ciFailed: 0,
    ciRecovered: 0,
    notable: [],
  };
}

function applyIssueOutcome(summary: PollSummary, outcome: "created" | "updated" | "unchanged") {
  if (outcome === "created") {
    summary.created += 1;
    return;
  }
  if (outcome === "updated") {
    summary.updated += 1;
    return;
  }
  summary.unchanged += 1;
}

function logPollSummaries(summaries: PollSummary[]) {
  for (const summary of summaries) {
    logOperatorNotice({
      title: `${summary.provider} poll`,
      message: buildOperatorPollSummaryMessage(summary),
      kind: summary.failed > 0 ? "warning" : "success",
    });
    logNarrative({
      title: "Poll Results",
      message: buildPollSummaryMessage(summary),
      operation: "delivery_poll_results",
      provider: summary.provider.toLowerCase().replace(/\s+/gu, "_"),
    });
    for (const notable of summary.notable) {
      logOperatorNotice({
        title: summary.provider,
        message: notable,
      });
      logNarrative({
        title: "Poll Results",
        message: notable,
        operation: "delivery_poll_notable",
        provider: summary.provider.toLowerCase().replace(/\s+/gu, "_"),
      });
    }
  }
}

function buildPollSummaryMessage(summary: PollSummary): string {
  if (summary.provider === "GitHub" || summary.provider === "Linear") {
    return `${summary.provider} checked ${summary.checked} issues in ${summary.scope}, created ${summary.created}, updated ${summary.updated}, left ${summary.unchanged} unchanged, skipped ${summary.skipped}, and failed ${summary.failed}`;
  }
  return `${summary.provider} checked ${summary.checked} tasks in ${summary.scope}, detected ${summary.ciFailed} failures, ${summary.ciRecovered} recoveries, left ${summary.unchanged} unchanged, and failed ${summary.failed}`;
}

function buildOperatorPollSummaryMessage(summary: PollSummary): string {
  if (summary.provider === "GitHub" || summary.provider === "Linear") {
    return `${summary.checked} issues checked; ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.failed} failed`;
  }
  return `${summary.checked} tasks checked; ${summary.ciFailed} failures, ${summary.ciRecovered} recoveries, ${summary.unchanged} unchanged, ${summary.failed} failed`;
}

function formatIssueNarrative({
  provider,
  identifier,
  outcome,
  routing,
}: {
  provider: "GitHub" | "Linear";
  identifier: string;
  outcome: "created" | "updated";
  routing?: {
    kind: "assigned" | "triage" | "stored_without_routing";
    target: string | null;
  };
}): string {
  const verb = outcome === "created" ? "Found" : "Updated";
  const base = `${verb} ${provider} issue ${identifier}`;
  if (!routing) return base;
  if (routing.kind === "assigned" && routing.target) {
    return `${base} and assigned it to ${routing.target}`;
  }
  if (routing.kind === "triage" && routing.target) {
    return `${base} and sent it to triage queue ${routing.target}`;
  }
  return `${base} and stored it without routing`;
}

function formatInterval(value: number): string {
  if (value % 60_000 === 0) {
    const minutes = value / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const seconds = Math.round(value / 1000);
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

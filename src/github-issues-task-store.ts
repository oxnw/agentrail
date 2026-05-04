import { TaskLifecycleError } from "./task-lifecycle-errors.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 100;

function mapStatus(issueState: string, labels: string[]): string {
  if (issueState === "closed") return "done";
  if (labels.includes("in review")) return "in_review";
  if (labels.includes("blocked")) return "blocked";
  if (labels.includes("in progress")) return "in_progress";
  return "todo";
}

function mapPriority(labels: string[]): string {
  if (labels.includes("priority: critical") || labels.includes("critical")) return "critical";
  if (labels.includes("priority: high") || labels.includes("high")) return "high";
  if (labels.includes("priority: medium") || labels.includes("medium")) return "medium";
  if (labels.includes("priority: low") || labels.includes("low")) return "low";
  return "medium";
}

function computeAvailableActions(status: string): string[] {
  if (status === "todo" || status === "in_progress") return ["submit"];
  if (status === "in_review") return ["ship", "submit"];
  if (status === "done") return ["rollback"];
  return [];
}

function extractAcceptanceCriteria(body: string | null): string[] {
  if (!body) return [];
  const match = body.match(/##\s*Acceptance\s*Criteria?\s*([\s\S]*?)(?=##|$)/i);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line.length > 0);
}

function toTaskId(taskId: string): string {
  return String(taskId ?? "");
}

interface GitHubIssuesTaskStoreOptions {
  taskSources?: Map<string, unknown> | null;
  githubToken?: string | null;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}

interface Principal {
  agent?: {
    id?: string;
    externalIdentities?: Array<{ provider: string; subject: string }>;
  } | null;
  keyId?: string;
}

function resolveGitHubLogin(principal?: Principal | null): string | null {
  if (principal?.agent?.externalIdentities) {
    const githubIdentity = principal.agent.externalIdentities.find(
      (e) => e.provider === "github"
    );
    if (githubIdentity?.subject) {
      return githubIdentity.subject;
    }
  }
  const envLogin = process.env.GITHUB_ASSIGNEE_LOGIN || process.env.GITHUB_LOGIN;
  if (envLogin) {
    return envLogin;
  }
  return null;
}

export class GitHubIssuesTaskStore {
  taskSources: Map<string, unknown> | null;
  githubToken: string | null;
  fetch: typeof globalThis.fetch;
  apiBaseUrl: string;
  defaultOwner: string | null;
  defaultRepo: string | null;

  constructor({
    taskSources = null,
    githubToken = process.env.GITHUB_TOKEN || null,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
  }: GitHubIssuesTaskStoreOptions = {}) {
    this.taskSources = taskSources ?? null;
    this.githubToken = githubToken ?? null;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");

    const firstSource = this.taskSources ? [...this.taskSources.values()][0] as Record<string, unknown> | undefined : undefined;
    this.defaultOwner = firstSource?.owner as string | undefined || process.env.GITHUB_OWNER || null;
    this.defaultRepo = firstSource?.repo as string | undefined || process.env.GITHUB_REPO || null;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (this.githubToken) {
      h.authorization = `Bearer ${this.githubToken}`;
    }
    return h;
  }

  async fetchJson(url: string): Promise<any> {
    const res = await this.fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new TaskLifecycleError(
          res.status === 403 ? 429 : 502,
          res.status === 403 ? "rate_limited" : "upstream_error",
          `GitHub API rejected the request: ${res.status} ${text.slice(0, 200)}`,
          { availableActions: ["retry"] }
        );
      }
      if (res.status === 404) {
        throw new TaskLifecycleError(404, "not_found", "GitHub issue not found.", { availableActions: ["list_my_tasks"] });
      }
      throw new TaskLifecycleError(502, "upstream_error", `GitHub API error: ${res.status} ${text.slice(0, 200)}`, { availableActions: ["retry"] });
    }
    return res.json();
  }

  resolveRepo(): { owner: string; repo: string } {
    if (!this.defaultOwner || !this.defaultRepo) {
      throw new TaskLifecycleError(
        500,
        "misconfigured",
        "GitHub owner/repo not configured. Set GITHUB_OWNER/GITHUB_REPO or include owner/repo in AGENTRAIL_TASK_SOURCES.",
        { availableActions: ["contact_support"] }
      );
    }
    return { owner: this.defaultOwner, repo: this.defaultRepo };
  }

  findTaskSourceEntry(issueNumber: number): { key: string; source: Record<string, unknown> } | null {
    if (!this.taskSources) return null;
    for (const [key, value] of this.taskSources.entries()) {
      const source = value as Record<string, unknown>;
      if (source.issueNumber === issueNumber || source.issue_number === issueNumber || Number(source.issueNumber) === issueNumber || Number(source.issue_number) === issueNumber) {
        return { key, source };
      }
    }
    return null;
  }

  toTaskId(issueNumber: number, fallbackKey?: string): string {
    if (fallbackKey) return fallbackKey;
    return `tsk_gh${issueNumber}`;
  }

  parseIssueNumber(taskId: string): number | null {
    // Check taskSources first
    if (this.taskSources) {
      const source = this.taskSources.get(taskId) as Record<string, unknown> | undefined;
      if (source) {
        const num = Number(source.issueNumber ?? source.issue_number);
        if (Number.isFinite(num)) return num;
      }
    }

    // Synthetic pattern: tsk_gh<digits>
    const match = taskId.match(/^tsk_gh(\d+)$/);
    if (match) {
      const num = Number(match[1]);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  async listMyTasks({
    status,
    limit = DEFAULT_PER_PAGE,
    cursor = null,
    principal = null,
  }: {
    status?: string;
    limit?: number;
    cursor?: string | null;
    principal?: Principal | null;
  } = {}) {
    const assignee = resolveGitHubLogin(principal);
    if (!assignee) {
      return {
        data: [],
        page: { nextCursor: null, hasMore: false },
        availableActions: [],
        meta: { tokenBudgetHint: "compact", reason: "no_github_identity" },
      };
    }

    const { owner, repo } = this.resolveRepo();

    let state = "open";
    if (status === "done") state = "closed";
    if (status === "all") state = "all";

    const normalizedLimit = Math.min(MAX_PER_PAGE, Math.max(1, Number(limit) || DEFAULT_PER_PAGE));
    const perPage = normalizedLimit + 1; // fetch one extra to detect hasMore

    let page = 1;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        const parsed = Number(decoded);
        if (Number.isFinite(parsed) && parsed > 0) page = parsed;
      } catch {
        // ignore invalid cursor, start at page 1
      }
    }

    const params = new URLSearchParams();
    params.set("assignee", assignee);
    params.set("state", state);
    params.set("per_page", String(perPage));
    params.set("page", String(page));

    const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/issues?${params}`;
    const issues = await this.fetchJson(url);

    if (!Array.isArray(issues)) {
      throw new TaskLifecycleError(502, "upstream_error", "Unexpected GitHub issues response format.", { availableActions: ["retry"] });
    }

    const hasMore = issues.length > normalizedLimit;
    const slice = issues.slice(0, normalizedLimit).filter((issue: any) => !issue.pull_request);

    const data = slice.map((issue: any) => {
      const labels: string[] = (issue.labels ?? []).map((l: any) =>
        typeof l === "string" ? l : (l.name ?? "")
      );
      const priority = mapPriority(labels);
      const statusValue = mapStatus(issue.state ?? "open", labels);
      const issueNumber = Number(issue.number);
      const sourceEntry = this.findTaskSourceEntry(issueNumber);
      const id = this.toTaskId(issueNumber, sourceEntry?.key);

      return {
        i: id,
        t: truncate(issue.title ?? "", 40),
        s: statusValue,
        p: priority,
      };
    });

    const nextCursor = hasMore
      ? Buffer.from(String(page + 1)).toString("base64url")
      : null;

    const availableActions = hasMore ? ["fetch_next_page"] : [];

    return {
      data,
      page: { nextCursor, hasMore },
      availableActions,
      meta: { tokenBudgetHint: "compact" },
    };
  }

  async getTask(taskId: string) {
    const issueNumber = this.parseIssueNumber(taskId);
    if (issueNumber === null) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", { availableActions: ["list_my_tasks"] });
    }

    const { owner, repo } = this.resolveRepo();

    const issue = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`
    );

    const labels: string[] = (issue.labels ?? []).map((l: any) =>
      typeof l === "string" ? l : (l.name ?? "")
    );
    const priority = mapPriority(labels);
    const status = mapStatus(issue.state ?? "open", labels);
    const acceptanceCriteria = extractAcceptanceCriteria(issue.body ?? null);
    const availableActions = computeAvailableActions(status);

    return {
      data: {
        id: taskId,
        identifier: `#${issueNumber}`,
        title: issue.title ?? "",
        description: issue.body ?? "",
        status,
        priority,
        assignee: issue.assignees?.[0]
          ? { id: `gh_${issue.assignees[0].login}`, name: issue.assignees[0].login }
          : null,
        acceptanceCriteria,
        links: {
          issue: issue.html_url ?? null,
        },
        context: {
          project: `${owner}/${repo}`,
          goal: "GitHub issue",
        },
        updatedAt: issue.updated_at ?? null,
        availableActions,
      },
      availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: [],
      },
    };
  }
}

function truncate(value: string, maxLength: number): string {
  const s = String(value ?? "");
  if (s.length <= maxLength) return s;
  return `${s.slice(0, maxLength - 3)}...`;
}

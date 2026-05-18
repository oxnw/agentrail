import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { resolveTaskSource } from "./task-source-resolution.ts";
import type { TaskRecord } from "./task-store.ts";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const IDEMPOTENCY_TAG = "<!-- agentrail-idempotency-key:";

export class GitHubSubmitAdapter {
  declare githubToken: string | undefined;
  declare fetch: typeof globalThis.fetch;
  declare apiBaseUrl: string;
  declare delegate: any;
  declare idempotencyRecords: Map<string, any>;
  declare getTask: ((taskId: string) => TaskRecord | null) | null;
  declare repos: Array<{ slug: string; defaultBranch?: string | null }> | null;
  constructor({
    getTask = null,
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
    delegate = null,
    repos = [],
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubSubmitAdapter requires a fetch implementation.");
    }

    this.getTask = getTask;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.delegate = delegate;
    this.idempotencyRecords = new Map();
    this.repos = Array.isArray(repos) ? repos : [];
  }

  async submitTask(taskId, payload, idempotencyKey) {
    const rawSource = resolveTaskSource(taskId, {
      getTask: this.getTask,
    });
    if (!rawSource) {
      if (this.delegate) {
        return this.delegate.submitTask(taskId, payload, idempotencyKey);
      }
      throw new TaskLifecycleError(404, "not_found", "No persisted task source metadata found for this task.", {
        availableActions: ["list_my_tasks"],
      });
    }
    const source = this.resolveGitHubSource(rawSource);

    validateSource(source);
    validateIdempotencyKey(idempotencyKey);

    const key = `submit:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const existing = this.idempotencyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Idempotency-Key has already been used with a different request payload.",
          { idempotencyKey, availableActions: ["retry"] },
        );
      }
      return structuredClone(existing.response);
    }

    const pullRequest = payload.pullRequest ?? {};
    const head = pullRequest.head ?? payload.head ?? source.branch;
    const base = pullRequest.base ?? payload.base ?? source.baseBranch ?? "main";

    if (!head) {
      throw new TaskLifecycleError(400, "validation_error", "`head` branch is required in payload or task source.", {
        availableActions: ["retry"],
      });
    }

    const existingPR = await this.findExistingPR(source, head, base, idempotencyKey);
    if (existingPR) {
      const response = buildExistingResponse(taskId, existingPR, idempotencyKey, source);
      this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
      return response;
    }

    const title = pullRequest.title ?? payload.title ?? payload.summary ?? `Submit ${taskId}`;
    let body = pullRequest.body ?? payload.body ?? payload.summary ?? "";
    if (source.issueNumber) {
      body = `Closes #${source.issueNumber}\n\n${body}`;
    }
    if (idempotencyKey) {
      body = `${body}\n\n${IDEMPOTENCY_TAG} ${idempotencyKey} -->`;
    }

    const pr = await this.createPR(source, { title, body, head, base, draft: pullRequest.draft ?? payload.draft ?? false });

    const reviewers = firstArray(pullRequest.reviewers, payload.reviewers, source.reviewers);
    if (reviewers.length > 0) {
      await this.requestReviewers(source, pr.number, reviewers).catch(() => {});
    }

    if (source.issueNumber) {
      await this.postIssueComment(source, source.issueNumber, pr).catch(() => {});
    }

    const response = buildCreatedResponse(taskId, pr, idempotencyKey, source);
    this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  async findExistingPR(source, head, base, idempotencyKey) {
    if (idempotencyKey) {
      const prs = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls?state=all&per_page=30`,
      );
      for (const pr of prs) {
        if (extractIdempotencyKey(pr.body ?? "") === idempotencyKey) {
          return pr;
        }
      }
    }

    const params = new URLSearchParams({ state: "open", head: `${source.owner}:${head}`, base, per_page: "1" });
    const prs = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls?${params}`,
    );
    return prs.length > 0 ? prs[0] : null;
  }

  async createPR(source, { title, body, head, base, draft }) {
    return this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({ title, body, head, base, draft }),
      },
    );
  }

  async requestReviewers(source, prNumber, reviewers) {
    return this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${prNumber}/requested_reviewers`,
      {
        method: "POST",
        body: JSON.stringify({ reviewers }),
      },
    );
  }

  async postIssueComment(source, issueNumber, pr) {
    const commentBody = `PR [#${pr.number}](${pr.html_url}) submitted via AgentRail`;
    return this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: commentBody }),
      },
    );
  }

  async shipTask(taskId, payload, idempotencyKey) {
    const rawSource = resolveTaskSource(taskId, {
      getTask: this.getTask,
    });
    if (!rawSource) {
      if (this.delegate && typeof this.delegate.shipTask === "function") {
        return this.delegate.shipTask(taskId, payload, idempotencyKey);
      }
      throw new TaskLifecycleError(404, "not_found", "No persisted task source metadata found for this task.", {
        availableActions: ["list_my_tasks"],
      });
    }
    const source = this.resolveGitHubSource(rawSource);

    validateSource(source);
    validateIdempotencyKey(idempotencyKey);

    const prNumber = payload.prNumber ?? source.prNumber;
    if (!prNumber) {
      throw new TaskLifecycleError(400, "validation_error", "prNumber is required in payload or task source.", {
        availableActions: ["retry"],
      });
    }

    const key = `ship:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const existing = this.idempotencyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Idempotency-Key has already been used with a different request payload.",
          { idempotencyKey, availableActions: ["retry"] },
        );
      }
      return structuredClone(existing.response);
    }

    const mergeMethod = payload.mergeMethod ?? "squash";

    // Fetch PR details
    const pr = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${prNumber}`,
    );

    // Already merged — idempotent success
    if (pr.merged) {
      const issue = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${source.issueNumber}`,
      ).catch(() => null);

      const response = {
        data: {
          taskId,
          operationId: `ghship_${prNumber}`,
          status: "merged",
          prUrl: pr.html_url,
          prNumber,
          mergeCommitSha: pr.merge_commit_sha,
          issueUrl: issue?.html_url ?? null,
          issueState: issue?.state ?? null,
          availableActions: ["rollback"],
        },
        availableActions: ["rollback"],
      };
      this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
      return response;
    }

    // PR is closed without merge
    if (pr.state === "closed") {
      throw new TaskLifecycleError(409, "not_mergeable", "PR is closed and cannot be merged.", {
        prNumber,
        prUrl: pr.html_url,
        availableActions: ["submit"],
      });
    }

    // Check mergeable state
    if (pr.mergeable === false) {
      const code = pr.mergeable_state === "dirty" ? "merge_conflict" : "not_mergeable";
      const reason = pr.mergeable_state === "dirty"
        ? "PR has merge conflicts that must be resolved."
        : `PR is not mergeable (state: ${pr.mergeable_state}).`;

      throw new TaskLifecycleError(409, code, reason, {
        prNumber,
        prUrl: pr.html_url,
        mergeableState: pr.mergeable_state,
        availableActions: ["get_task"],
      });
    }

    // Check CI status via combined status
    const combinedStatus = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/commits/${pr.head.sha}/status`,
    ).catch(() => null);

    if (combinedStatus && combinedStatus.state === "failure") {
      throw new TaskLifecycleError(409, "ci_failing", "CI checks are failing. Fix them before shipping.", {
        prNumber,
        prUrl: pr.html_url,
        ciStatus: combinedStatus.state,
        availableActions: ["view_ci_status", "submit"],
      });
    }

    // Attempt merge
    try {
      const mergeResult = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${prNumber}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({ merge_method: mergeMethod }),
        },
      );

      // Close associated issue
      if (source.issueNumber) {
        await this.fetchJson(
          `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${source.issueNumber}`,
          {
            method: "PATCH",
            body: JSON.stringify({ state: "closed", state_reason: "completed" }),
          },
        ).catch(() => {});
      }

      const issue = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${source.issueNumber}`,
      ).catch(() => null);

      const response = {
        data: {
          taskId,
          operationId: `ghship_${prNumber}`,
          status: "merged",
          prUrl: pr.html_url,
          prNumber,
          mergeCommitSha: mergeResult.sha,
          issueUrl: issue?.html_url ?? null,
          issueState: issue?.state ?? null,
          availableActions: ["rollback"],
        },
        availableActions: ["rollback"],
      };
      this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
      return response;
    } catch (err) {
      const status = (err as any).details?.upstreamStatus ?? err.statusCode;
      const message = err.message ?? "Merge failed";

      if (status === 405) {
        throw new TaskLifecycleError(409, "review_required", "PR requires approved review before merging.", {
          prNumber,
          prUrl: pr.html_url,
          availableActions: ["view_review_feedback"],
        });
      }

      if (status === 409) {
        throw new TaskLifecycleError(409, "merge_conflict", "Merge conflict: head branch was modified during merge.", {
          prNumber,
          prUrl: pr.html_url,
          availableActions: ["get_task"],
        });
      }

      if (status === 403) {
        throw new TaskLifecycleError(403, "insufficient_permission", "You do not have permission to merge this PR.", {
          prNumber,
          prUrl: pr.html_url,
          availableActions: ["contact_support"],
        });
      }

      throw err;
    }
  }

  async fetchJson(url: string, options: { method?: string; body?: string } = {}): Promise<any> {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const statusCode = response.status === 422 ? 422 : 502;
      const error = new TaskLifecycleError(
        statusCode,
        statusCode === 422 ? "validation_error" : "upstream_error",
        `GitHub API error: ${response.status} ${text.slice(0, 200)}`,
        { availableActions: ["retry"], upstreamStatus: response.status },
      );
      throw error;
    }

    return response.json();
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

  resolveGitHubSource(source) {
    if (
      typeof source?.owner === "string"
      && source.owner.length > 0
      && typeof source?.repo === "string"
      && source.repo.length > 0
    ) {
      return source;
    }
    if (source?.provider !== "linear") {
      return source;
    }
    const primaryRepo = this.repos?.[0] ?? null;
    if (!primaryRepo?.slug || typeof primaryRepo.slug !== "string") {
      return source;
    }
    const [owner, repo] = primaryRepo.slug.split("/", 2);
    if (!owner || !repo) {
      return source;
    }
    return {
      ...source,
      owner,
      repo,
      baseBranch: source.baseBranch ?? primaryRepo.defaultBranch ?? "main",
    };
  }
}

function validateSource(source) {
  for (const field of ["owner", "repo"]) {
    if (typeof source[field] !== "string" || source[field].length === 0) {
      throw new TaskLifecycleError(500, "misconfigured", `Task source is missing GitHub ${field}.`, {
        availableActions: ["contact_support"],
      });
    }
  }
}

function validateIdempotencyKey(key) {
  if (!key) {
    throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
      availableActions: ["retry"],
    });
  }
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function extractIdempotencyKey(body) {
  const idx = body.indexOf(IDEMPOTENCY_TAG);
  if (idx === -1) return null;
  const start = idx + IDEMPOTENCY_TAG.length;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;
  return body.slice(start, end).trim();
}

function buildExistingResponse(taskId, pr, idempotencyKey, source) {
  return {
    data: {
      submissionId: `ghpr_${pr.number}`,
      taskId,
      status: "in_review",
      prUrl: pr.html_url,
      prNumber: pr.number,
      owner: source.owner ?? null,
      repo: source.repo ?? null,
      ciProvider: inferSubmitCiProvider(source),
      head: pr.head?.ref ?? null,
      base: pr.base?.ref ?? null,
      headSha: pr.head?.sha ?? null,
      action: "existing",
      acceptedAt: pr.created_at ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      availableActions: ["view_review_feedback", "view_ci_status"],
    },
    availableActions: ["view_review_feedback"],
  };
}

function buildCreatedResponse(taskId, pr, idempotencyKey, source) {
  return {
    data: {
      submissionId: `ghpr_${pr.number}`,
      taskId,
      status: "in_review",
      prUrl: pr.html_url,
      prNumber: pr.number,
      owner: source.owner ?? null,
      repo: source.repo ?? null,
      ciProvider: inferSubmitCiProvider(source),
      head: pr.head?.ref ?? null,
      base: pr.base?.ref ?? null,
      headSha: pr.head?.sha ?? null,
      action: "created",
      acceptedAt: pr.created_at ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      availableActions: ["view_review_feedback", "view_ci_status"],
    },
    availableActions: ["view_review_feedback"],
  };
}

function inferSubmitCiProvider(source) {
  if (typeof source?.ciProvider === "string" && source.ciProvider.length > 0) {
    return source.ciProvider;
  }
  if (typeof source?.projectSlug === "string" && source.projectSlug.length > 0) {
    return "circleci";
  }
  return "github_actions";
}

export { extractIdempotencyKey, IDEMPOTENCY_TAG };

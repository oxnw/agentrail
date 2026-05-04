import { TaskLifecycleError } from "./task-lifecycle-errors.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const IDEMPOTENCY_TAG = "<!-- agentrail-idempotency-key:";

export class GitHubSubmitAdapter {
  declare taskSources: any;
  declare githubToken: string | undefined;
  declare fetch: typeof globalThis.fetch;
  declare apiBaseUrl: string;
  declare delegate: any;
  declare idempotencyRecords: Map<string, any>;
  constructor({
    taskSources = {},
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
    delegate = null,
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubSubmitAdapter requires a fetch implementation.");
    }

    this.taskSources = taskSources;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.delegate = delegate;
    this.idempotencyRecords = new Map();
  }

  async submitTask(taskId, payload, idempotencyKey) {
    const source = lookupTaskSource(this.taskSources, taskId);
    if (!source) {
      if (this.delegate) {
        return this.delegate.submitTask(taskId, payload, idempotencyKey);
      }
      throw new TaskLifecycleError(404, "not_found", "No task source configured for this task.", {
        availableActions: ["list_my_tasks"],
      });
    }

    validateSource(source);
    validateIdempotencyKey(idempotencyKey);

    const key = `submit:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const cached = this.idempotencyRecords.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Idempotency-Key has already been used with a different request payload.",
          { idempotencyKey, availableActions: ["retry"] },
        );
      }
      // Re-attempt reviewer assignment if it previously failed
      const replayResponse = structuredClone(cached.response);
      if (cached.reviewerWarnings && source.reviewers?.length > 0) {
        const prNumber = replayResponse.data?.prNumber;
        if (prNumber) {
          try {
            await this.requestReviewers(source, prNumber, source.reviewers);
            delete cached.reviewerWarnings;
            replayResponse.data.warnings = undefined;
          } catch {
            // keep previous warning
          }
        }
      }
      return replayResponse;
    }

    const head = payload.head ?? source.branch;
    const base = payload.base ?? source.baseBranch ?? "main";

    if (!head) {
      throw new TaskLifecycleError(400, "validation_error", "`head` branch is required in payload or task source.", {
        availableActions: ["retry"],
      });
    }

    const existingPR = await this.findExistingPR(source, head, base, idempotencyKey);
    if (existingPR) {
      const response = buildExistingResponse(taskId, existingPR, idempotencyKey, source.reviewers);
      this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
      await this.recordSubmission(taskId, response.data);
      return response;
    }

    const title = payload.title ?? payload.summary ?? `Submit ${taskId}`;
    let body = payload.body ?? payload.summary ?? "";
    if (source.issueNumber) {
      body = `Closes #${source.issueNumber}\n\n${body}`;
    }
    if (idempotencyKey) {
      body = `${body}\n\n${IDEMPOTENCY_TAG} ${idempotencyKey} -->`;
    }

    const pr = await this.createPR(source, { title, body, head, base, draft: payload.draft ?? false });

    const reviewers = payload.reviewers ?? source.reviewers ?? [];
    let reviewerWarnings = null;
    if (reviewers.length > 0) {
      try {
        await this.requestReviewers(source, pr.number, reviewers);
      } catch (err) {
        reviewerWarnings = {
          code: "reviewer_assignment_failed",
          message: err instanceof TaskLifecycleError ? err.message : String(err),
          reviewers,
        };
      }
    }

    if (source.issueNumber) {
      await this.postIssueComment(source, source.issueNumber, pr).catch(() => {});
    }

    const response = buildCreatedResponse(taskId, pr, idempotencyKey, reviewers, reviewerWarnings);
    this.idempotencyRecords.set(key, {
      fingerprint,
      response: structuredClone(response),
      ...(reviewerWarnings ? { reviewerWarnings } : {}),
    });

    await this.recordSubmission(taskId, response.data);

    return response;
  }

  async recordSubmission(taskId, submissionData) {
    if (this.delegate && typeof this.delegate.recordSubmission === "function") {
      await this.delegate.recordSubmission(taskId, submissionData).catch(() => {});
    }
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
      throw new TaskLifecycleError(
        statusCode,
        statusCode === 422 ? "validation_error" : "upstream_error",
        `GitHub API error: ${response.status} ${text.slice(0, 200)}`,
        { availableActions: ["retry"] },
      );
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
}

function lookupTaskSource(taskSources, taskId) {
  if (taskSources instanceof Map) {
    return taskSources.get(taskId) ?? null;
  }
  return taskSources?.[taskId] ?? null;
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

function extractIdempotencyKey(body) {
  const idx = body.indexOf(IDEMPOTENCY_TAG);
  if (idx === -1) return null;
  const start = idx + IDEMPOTENCY_TAG.length;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;
  return body.slice(start, end).trim();
}

function buildReviewRoute(reviewers) {
  if (!reviewers || reviewers.length === 0) {
    return { participants: [] };
  }
  return {
    participants: reviewers.map((login) => ({ id: login, role: "reviewer" })),
  };
}

function buildExistingResponse(taskId, pr, idempotencyKey, reviewers = [], reviewerWarnings = null) {
  return {
    data: {
      submissionId: `ghpr_${pr.number}`,
      taskId,
      status: "in_review",
      reviewRoute: buildReviewRoute(reviewers),
      prUrl: pr.html_url,
      prNumber: pr.number,
      action: "existing",
      acceptedAt: pr.created_at ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(reviewerWarnings ? { warnings: [reviewerWarnings] } : {}),
      availableActions: ["view_review_feedback", "view_ci_status"],
    },
    availableActions: ["view_review_feedback"],
  };
}

function buildCreatedResponse(taskId, pr, idempotencyKey, reviewers = [], reviewerWarnings = null) {
  return {
    data: {
      submissionId: `ghpr_${pr.number}`,
      taskId,
      status: "in_review",
      reviewRoute: buildReviewRoute(reviewers),
      prUrl: pr.html_url,
      prNumber: pr.number,
      action: "created",
      acceptedAt: pr.created_at ?? new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(reviewerWarnings ? { warnings: [reviewerWarnings] } : {}),
      availableActions: ["view_review_feedback", "view_ci_status"],
    },
    availableActions: ["view_review_feedback"],
  };
}

export { extractIdempotencyKey, IDEMPOTENCY_TAG };

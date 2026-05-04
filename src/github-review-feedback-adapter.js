const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const MAX_COMMENTS = 100;

const SEVERITY_ORDER = { must_fix: 0, should_fix: 1, note: 2 };

export class ReviewFeedbackSourceError extends Error {
  constructor(message, { statusCode = 502, code = "review_source_unavailable", details = {} } = {}) {
    super(message);
    this.name = "ReviewFeedbackSourceError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class GitHubReviewFeedbackAdapter {
  constructor({
    taskSources = {},
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubReviewFeedbackAdapter requires a fetch implementation.");
    }

    this.taskSources = taskSources;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
  }

  async getTaskReviewFeedback(taskId) {
    const source = lookupTaskSource(this.taskSources, taskId);
    if (!source) {
      return null;
    }

    validateTaskSource(source);

    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.listPullReviews(source),
      this.listReviewComments(source),
      this.listIssueComments(source)
    ]);

    const latestDecision = deriveLatestDecision(reviews);
    const feedbackItems = unifyFeedback({ reviews, reviewComments, issueComments });
    const availableActions = actionsForDecision(latestDecision.outcome);

    return {
      data: {
        taskId,
        latestDecision,
        comments: feedbackItems,
        availableActions
      },
      availableActions
    };
  }

  async listPullReviews(source) {
    const body = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${source.pullNumber}/reviews?per_page=100`
    );
    return Array.isArray(body) ? body : [];
  }

  async listReviewComments(source) {
    const body = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${source.pullNumber}/comments?per_page=100`
    );
    return Array.isArray(body) ? body : [];
  }

  async listIssueComments(source) {
    const body = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${source.pullNumber}/comments?per_page=100`
    );
    return Array.isArray(body) ? body : [];
  }

  async fetchJson(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw await toSourceError(response);
    }

    return response.json();
  }

  headers() {
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };

    if (this.githubToken) {
      headers.authorization = `Bearer ${this.githubToken}`;
    }

    return headers;
  }
}

function lookupTaskSource(taskSources, taskId) {
  if (taskSources instanceof Map) {
    return taskSources.get(taskId) ?? null;
  }

  return taskSources?.[taskId] ?? null;
}

function validateTaskSource(source) {
  for (const field of ["owner", "repo", "pullNumber"]) {
    const value = source[field];
    if (field === "pullNumber") {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ReviewFeedbackSourceError(`Task review source is missing GitHub ${field}.`, {
          statusCode: 500,
          code: "review_source_misconfigured",
          details: { field, availableActions: ["contact_support"] }
        });
      }
    } else if (typeof value !== "string" || value.length === 0) {
      throw new ReviewFeedbackSourceError(`Task review source is missing GitHub ${field}.`, {
        statusCode: 500,
        code: "review_source_misconfigured",
        details: { field, availableActions: ["contact_support"] }
      });
    }
  }
}

function deriveLatestDecision(reviews) {
  const decisionalReviews = reviews
    .filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
    .sort((left, right) => new Date(right.submitted_at).getTime() - new Date(left.submitted_at).getTime());

  if (decisionalReviews.length === 0) {
    return {
      outcome: "pending",
      reviewer: { id: "unknown", role: "unknown" },
      createdAt: new Date(0).toISOString(),
      summary: "No review decision yet."
    };
  }

  const latest = decisionalReviews[0];
  return {
    outcome: latest.state === "APPROVED" ? "approved" : "changes_requested",
    reviewer: {
      id: latest.user?.login ?? "unknown",
      role: latest.author_association?.toLowerCase() ?? "contributor"
    },
    createdAt: latest.submitted_at,
    summary: latest.body || summarizeDecision(latest.state)
  };
}

function summarizeDecision(state) {
  return state === "APPROVED" ? "Changes approved." : "Changes requested.";
}

function unifyFeedback({ reviews, reviewComments, issueComments }) {
  const items = [];

  for (const review of reviews) {
    if (review.body && review.body.trim().length > 0) {
      items.push({
        id: `review_${review.id}`,
        authorRole: review.author_association?.toLowerCase() ?? "contributor",
        body: review.body,
        severity: severityFromReviewState(review.state),
        file: null,
        line: null,
        suggestedAction: null
      });
    }
  }

  for (const comment of reviewComments) {
    items.push({
      id: `rc_${comment.id}`,
      authorRole: comment.author_association?.toLowerCase() ?? "contributor",
      body: comment.body,
      severity: classifySeverity(comment.body),
      file: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      suggestedAction: extractSuggestion(comment.body)
    });
  }

  for (const comment of issueComments) {
    items.push({
      id: `ic_${comment.id}`,
      authorRole: comment.author_association?.toLowerCase() ?? "contributor",
      body: comment.body,
      severity: classifySeverity(comment.body),
      file: null,
      line: null,
      suggestedAction: null
    });
  }

  items.sort((left, right) => (SEVERITY_ORDER[left.severity] ?? 3) - (SEVERITY_ORDER[right.severity] ?? 3));
  return items.slice(0, MAX_COMMENTS);
}

function severityFromReviewState(state) {
  if (state === "CHANGES_REQUESTED") {
    return "must_fix";
  }

  if (state === "COMMENTED") {
    return "note";
  }

  return "note";
}

function classifySeverity(body) {
  const lower = (body ?? "").toLowerCase();
  if (/\b(must|require[ds]?|block(?:er|ing)?|critical|fix this)\b/.test(lower)) {
    return "must_fix";
  }

  if (/\b(should|suggest|consider|would be nice|prefer|recommend)\b/.test(lower)) {
    return "should_fix";
  }

  return "note";
}

function extractSuggestion(body) {
  const match = (body ?? "").match(/```suggestion\r?\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : null;
}

function actionsForDecision(outcome) {
  if (outcome === "approved") {
    return ["view_ci_status", "ship"];
  }

  if (outcome === "changes_requested") {
    return ["submit"];
  }

  return ["refresh"];
}

async function toSourceError(response) {
  const details = {
    sourceStatus: response.status,
    availableActions: ["retry"]
  };
  const body = await safeText(response);
  if (body) {
    details.sourceMessage = body.slice(0, 240);
  }

  if (response.status === 401 || response.status === 403) {
    return new ReviewFeedbackSourceError("GitHub review source rejected the request.", {
      statusCode: response.status === 403 ? 429 : 502,
      code: response.status === 403 ? "review_source_rate_limited" : "review_source_auth_failed",
      details
    });
  }

  if (response.status === 404) {
    return new ReviewFeedbackSourceError("GitHub pull request was not found.", {
      statusCode: 404,
      code: "not_found",
      details
    });
  }

  return new ReviewFeedbackSourceError("GitHub review source is unavailable.", { details });
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

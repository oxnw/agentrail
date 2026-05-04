import { Octokit } from "@octokit/rest";
import {
  Task, TaskSummary, CompactTaskSummary, LinkedPR, TaskComment,
  SubmitRequest, SubmitResult, ShipResult, ShipBlockedResult,
  FeedbackSeverity, ReviewFeedbackItem, ReviewFeedbackResponse,
} from "./types";
import {
  mapPriority,
  mapStatus,
  extractAcceptanceCriteria,
  computeAvailableActions,
} from "./priority-mapper";

export interface GitHubAdapterConfig {
  token: string;
  owner: string;
  repo: string;
}

export class GitHubAdapter {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: GitHubAdapterConfig) {
    this.octokit = new Octokit({ auth: config.token });
    this.owner = config.owner;
    this.repo = config.repo;
  }

  private issueId(number: number): string {
    return `${this.owner}/${this.repo}#${number}`;
  }

  private async fetchLinkedPRs(issueNumber: number): Promise<LinkedPR[]> {
    try {
      // GitHub doesn't have a direct "linked PRs" API; we search for PRs that
      // reference this issue number in their body or title.
      const { data: prs } = await this.octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        per_page: 20,
      });

      const pattern = new RegExp(
        `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\\s]+#?${issueNumber}\\b`,
        "i"
      );

      return prs
        .filter((pr) => pattern.test(pr.body ?? "") || pr.title.includes(`#${issueNumber}`))
        .map((pr) => ({
          number: pr.number,
          url: pr.html_url,
          title: pr.title,
          state: pr.state,
        }));
    } catch {
      return [];
    }
  }

  private async fetchComments(issueNumber: number): Promise<TaskComment[]> {
    const { data } = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 30,
    });

    return data.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
  }

  async getTask(issueNumber: number): Promise<Task> {
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const labels = issue.labels.map((l) =>
      typeof l === "string" ? l : (l.name ?? "")
    );
    const priority = mapPriority(labels);
    const status = mapStatus(issue.state, labels);
    const acceptanceCriteria = extractAcceptanceCriteria(issue.body ?? null);
    const availableActions = computeAvailableActions(status);

    const [linkedPRs, comments] = await Promise.all([
      this.fetchLinkedPRs(issueNumber),
      this.fetchComments(issueNumber),
    ]);

    return {
      id: this.issueId(issueNumber),
      source: "github",
      repo: `${this.owner}/${this.repo}`,
      number: issueNumber,
      title: issue.title,
      body: issue.body ?? "",
      status,
      priority,
      labels,
      assignees: issue.assignees?.map((a) => a.login) ?? [],
      acceptanceCriteria,
      linkedPRs,
      comments,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      availableActions,
      meta: { tokenBudgetHint: 450 },
    };
  }

  async listTasksForAssignee(
    assignee: string,
    cursor?: string,
    perPage = 20
  ): Promise<{ tasks: TaskSummary[]; nextCursor: string | null; hasMore: boolean }> {
    const params: Parameters<typeof this.octokit.rest.issues.listForRepo>[0] = {
      owner: this.owner,
      repo: this.repo,
      assignee,
      state: "open",
      per_page: perPage + 1, // fetch one extra to detect hasMore
    };

    if (cursor) {
      // cursor is base64-encoded page number
      const page = parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
      if (!isNaN(page)) params.page = page;
    }

    const { data: issues } = await this.octokit.rest.issues.listForRepo(params);

    const hasMore = issues.length > perPage;
    const page = issues.slice(0, perPage);
    const currentPage = cursor
      ? parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10)
      : 1;
    const nextCursor = hasMore
      ? Buffer.from(String(currentPage + 1)).toString("base64")
      : null;

    const tasks: TaskSummary[] = page
      .filter((issue) => !issue.pull_request) // exclude PRs from issue list
      .map((issue) => {
        const labels = issue.labels.map((l) =>
          typeof l === "string" ? l : (l.name ?? "")
        );
        const priority = mapPriority(labels);
        const status = mapStatus(issue.state, labels);
        return {
          id: this.issueId(issue.number),
          source: "github" as const,
          repo: `${this.owner}/${this.repo}`,
          number: issue.number,
          title: issue.title,
          status,
          priority,
          labels,
          url: issue.html_url,
          updatedAt: issue.updated_at,
          availableActions: computeAvailableActions(status),
        };
      });

    return { tasks, nextCursor, hasMore };
  }

  async listTasksCompact(
    assignee: string,
    cursor?: string,
    perPage = 10
  ): Promise<{ repo: string; tasks: CompactTaskSummary[]; nextCursor: string | null; hasMore: boolean }> {
    const { tasks, nextCursor, hasMore } = await this.listTasksForAssignee(assignee, cursor, perPage);
    const compact: CompactTaskSummary[] = tasks.map((t) => ({
      n: t.number,
      t: t.title.length > 50 ? t.title.slice(0, 47) + "..." : t.title,
      s: t.status,
      p: t.priority,
    }));
    return { repo: `${this.owner}/${this.repo}`, tasks: compact, nextCursor, hasMore };
  }

  static IDEMPOTENCY_TAG = "<!-- agentrail-idempotency-key:";

  private extractIdempotencyKey(body: string): string | null {
    const tag = GitHubAdapter.IDEMPOTENCY_TAG;
    const idx = body.indexOf(tag);
    if (idx === -1) return null;
    const start = idx + tag.length;
    const end = body.indexOf("-->", start);
    if (end === -1) return null;
    return body.slice(start, end).trim();
  }

  private embedIdempotencyKey(body: string, key: string): string {
    return `${body}\n\n${GitHubAdapter.IDEMPOTENCY_TAG} ${key} -->`;
  }

  private async findPRByIdempotencyKey(key: string): Promise<LinkedPR | null> {
    const { data: prs } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "all",
      per_page: 30,
    });
    for (const pr of prs) {
      if (this.extractIdempotencyKey(pr.body ?? "") === key) {
        return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state };
      }
    }
    return null;
  }

  private async findPRByHeadBranch(head: string, base: string): Promise<LinkedPR | null> {
    const { data: prs } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${this.owner}:${head}`,
      base,
      per_page: 1,
    });
    if (prs.length > 0) {
      const pr = prs[0];
      return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state };
    }
    return null;
  }

  private buildExistingResult(
    prDetail: { number: number; html_url: string; title: string; state: string; draft?: boolean; base: { ref: string }; head: { ref: string }; requested_reviewers?: Array<{ login?: string }> | null },
    issueNumber: number,
    idempotencyKey?: string,
  ): SubmitResult {
    return {
      action: "existing",
      pr: {
        number: prDetail.number,
        url: prDetail.html_url,
        title: prDetail.title,
        state: prDetail.state,
        draft: prDetail.draft ?? false,
        base: prDetail.base.ref,
        head: prDetail.head.ref,
        reviewers: (prDetail.requested_reviewers ?? [])
          .map((r: { login?: string }) => r.login ?? "")
          .filter(Boolean),
        checksStatus: "unknown",
      },
      issueNumber,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      availableActions: computeAvailableActions("in_review"),
    };
  }

  async submitTask(issueNumber: number, req: SubmitRequest): Promise<SubmitResult> {
    const base = req.base ?? "main";

    // Idempotency: check by key first, then by head branch
    if (req.idempotencyKey) {
      const existing = await this.findPRByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        const { data: prDetail } = await this.octokit.rest.pulls.get({
          owner: this.owner, repo: this.repo, pull_number: existing.number,
        });
        return this.buildExistingResult(prDetail, issueNumber, req.idempotencyKey);
      }
    }

    const branchMatch = await this.findPRByHeadBranch(req.head, base);
    if (branchMatch) {
      const { data: prDetail } = await this.octokit.rest.pulls.get({
        owner: this.owner, repo: this.repo, pull_number: branchMatch.number,
      });
      return this.buildExistingResult(prDetail, issueNumber, req.idempotencyKey);
    }

    // Fall back to linked-PR check (body/title regex)
    const existingPRs = await this.fetchLinkedPRs(issueNumber);
    const openPR = existingPRs.find((pr) => pr.state === "open");
    if (openPR) {
      const { data: prDetail } = await this.octokit.rest.pulls.get({
        owner: this.owner, repo: this.repo, pull_number: openPR.number,
      });
      return this.buildExistingResult(prDetail, issueNumber, req.idempotencyKey);
    }

    // Create new PR
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: this.owner, repo: this.repo, issue_number: issueNumber,
    });

    const title = req.title ?? issue.title;
    let body = req.body ?? `Closes #${issueNumber}\n\n${issue.body ?? ""}`;
    const draft = req.draft ?? false;

    if (req.idempotencyKey) {
      body = this.embedIdempotencyKey(body, req.idempotencyKey);
    }

    const { data: pr } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: req.head,
      base,
      draft,
    });

    let reviewers: string[] = [];
    if (req.reviewers && req.reviewers.length > 0) {
      try {
        const { data: reviewResult } = await this.octokit.rest.pulls.requestReviewers({
          owner: this.owner,
          repo: this.repo,
          pull_number: pr.number,
          reviewers: req.reviewers,
        });
        reviewers = reviewResult.requested_reviewers
          ?.map((r: { login?: string }) => r.login ?? "")
          .filter(Boolean) ?? [];
      } catch {
        reviewers = [];
      }
    }

    // Record PR URL on the GitHub issue
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body: `🔗 PR [#${pr.number}](${pr.html_url}) ${draft ? "(draft) " : ""}submitted via AgentRail`,
    }).catch(() => {});

    return {
      action: "created",
      pr: {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        state: pr.state,
        draft: pr.draft ?? false,
        base,
        head: req.head,
        reviewers,
        checksStatus: "pending",
      },
      issueNumber,
      ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
      availableActions: computeAvailableActions("in_review"),
    };
  }

  async shipTask(
    issueNumber: number,
    prNumber: number,
    mergeMethod: "merge" | "squash" | "rebase" = "squash"
  ): Promise<ShipResult | ShipBlockedResult> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    if (pr.merged) {
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });
      return {
        action: "merged",
        pr: {
          number: pr.number,
          url: pr.html_url,
          merged: true,
          mergeCommitSha: pr.merge_commit_sha,
        },
        issue: {
          number: issueNumber,
          url: issue.html_url,
          state: issue.state,
        },
        availableActions: computeAvailableActions("done"),
      };
    }

    if (pr.state === "closed") {
      return {
        action: "blocked",
        reason: "PR is closed and cannot be merged",
        code: "not_mergeable",
        pr: {
          number: pr.number,
          url: pr.html_url,
          mergeable: false,
          mergeableState: "closed",
        },
        availableActions: ["POST /tasks/{id}/submit"],
      };
    }

    if (pr.mergeable === false) {
      const reason = pr.mergeable_state === "dirty"
        ? "PR has merge conflicts that must be resolved"
        : pr.mergeable_state === "blocked"
          ? "PR is blocked by branch protection rules or required checks"
          : `PR is not mergeable (state: ${pr.mergeable_state})`;

      const code = pr.mergeable_state === "dirty"
        ? "merge_conflict" as const
        : pr.mergeable_state === "blocked"
          ? "branch_protection" as const
          : "not_mergeable" as const;

      return {
        action: "blocked",
        reason,
        code,
        pr: {
          number: pr.number,
          url: pr.html_url,
          mergeable: pr.mergeable ?? false,
          mergeableState: pr.mergeable_state,
        },
        availableActions: ["GET /tasks/{id}"],
      };
    }

    try {
      const { data: mergeResult } = await this.octokit.rest.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        merge_method: mergeMethod,
      });

      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: "closed",
        state_reason: "completed",
      });

      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });

      return {
        action: "merged",
        pr: {
          number: prNumber,
          url: pr.html_url,
          merged: true,
          mergeCommitSha: mergeResult.sha,
        },
        issue: {
          number: issueNumber,
          url: issue.html_url,
          state: issue.state,
        },
        availableActions: computeAvailableActions("done"),
      };
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const message = (err as { message?: string }).message ?? "Merge failed";

      if (status === 405) {
        return {
          action: "blocked",
          reason: message,
          code: "review_required",
          pr: {
            number: prNumber,
            url: pr.html_url,
            mergeable: pr.mergeable ?? false,
            mergeableState: pr.mergeable_state,
          },
          availableActions: ["GET /tasks/{id}"],
        };
      }

      if (status === 409) {
        return {
          action: "blocked",
          reason: "Merge conflict: head branch was modified during merge",
          code: "merge_conflict",
          pr: {
            number: prNumber,
            url: pr.html_url,
            mergeable: false,
            mergeableState: "dirty",
          },
          availableActions: ["GET /tasks/{id}"],
        };
      }

      throw err;
    }
  }

  async getReviewFeedback(issueNumber: number, prNumber: number): Promise<ReviewFeedbackResponse> {
    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.octokit.rest.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      }).then((r) => r.data),
      this.octokit.rest.pulls.listReviewComments({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      }).then((r) => r.data),
      this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        per_page: 50,
      }).then((r) => r.data),
    ]);

    const feedback: ReviewFeedbackItem[] = [];

    for (const review of reviews) {
      if (!review.body || review.state === "PENDING") continue;
      feedback.push({
        id: `review-${review.id}`,
        reviewer: review.user?.login ?? "unknown",
        severity: classifyReviewState(review.state),
        file: null,
        line: null,
        request: review.body,
        suggestedAction: null,
        url: review.html_url,
        createdAt: review.submitted_at ?? new Date().toISOString(),
        source: "review",
      });
    }

    for (const comment of reviewComments) {
      const suggested = extractSuggestion(comment.body ?? "");
      feedback.push({
        id: `rc-${comment.id}`,
        reviewer: comment.user?.login ?? "unknown",
        severity: classifySeverity(comment.body ?? ""),
        file: comment.path,
        line: comment.line ?? comment.original_line ?? null,
        request: comment.body ?? "",
        suggestedAction: suggested,
        url: comment.html_url,
        createdAt: comment.created_at,
        source: "review_comment",
      });
    }

    for (const comment of issueComments) {
      if (!comment.body) continue;
      if (comment.user?.type === "Bot") continue;
      feedback.push({
        id: `ic-${comment.id}`,
        reviewer: comment.user?.login ?? "unknown",
        severity: classifySeverity(comment.body),
        file: null,
        line: null,
        request: comment.body,
        suggestedAction: null,
        url: comment.html_url ?? "",
        createdAt: comment.created_at,
        source: "issue_comment",
      });
    }

    const severityOrder: Record<FeedbackSeverity, number> = { required: 0, suggestion: 1, nitpick: 2 };
    feedback.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const summary = {
      total: feedback.length,
      required: feedback.filter((f) => f.severity === "required").length,
      suggestion: feedback.filter((f) => f.severity === "suggestion").length,
      nitpick: feedback.filter((f) => f.severity === "nitpick").length,
    };

    return {
      taskId: this.issueId(issueNumber),
      prNumber,
      feedback,
      summary,
      availableActions: computeAvailableActions("in_review"),
    };
  }
}

export function classifyReviewState(state: string): FeedbackSeverity {
  if (state === "CHANGES_REQUESTED") return "required";
  if (state === "COMMENTED") return "suggestion";
  return "suggestion";
}

const REQUIRED_PATTERNS = /\b(must|required|breaking|block(?:er|ing)?|critical|fix this|do not merge)\b/i;
const NITPICK_PATTERNS = /\b(nit(?:pick)?|minor|optional|style|cosmetic|bikeshed)\b/i;

export function classifySeverity(body: string): FeedbackSeverity {
  if (REQUIRED_PATTERNS.test(body)) return "required";
  if (NITPICK_PATTERNS.test(body)) return "nitpick";
  return "suggestion";
}

export function extractSuggestion(body: string): string | null {
  const match = body.match(/```suggestion\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : null;
}

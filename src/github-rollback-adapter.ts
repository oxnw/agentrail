import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { resolveTaskSource } from "./task-source-resolution.ts";
import type { TaskRecord } from "./task-store.ts";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

export class RollbackSourceError extends Error {
  declare statusCode: number;
  declare code: string;
  declare details: Record<string, unknown>;
  constructor(message, { statusCode = 502, code = "rollback_source_unavailable", details = {} } = {}) {
    super(message);
    this.name = "RollbackSourceError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class GitHubRollbackAdapter {
  declare taskSources: any;
  declare githubToken: string | undefined;
  declare fetch: typeof globalThis.fetch;
  declare apiBaseUrl: string;
  declare getTask: ((taskId: string) => TaskRecord | null) | null;
  constructor({
    taskSources = {},
    getTask = null,
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubRollbackAdapter requires a fetch implementation.");
    }

    this.taskSources = taskSources;
    this.getTask = getTask;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
  }

  async rollbackTask(taskId, payload, idempotencyKey) {
    const source = this.lookupTaskSource(taskId);
    if (!source) {
      throw new TaskLifecycleError(404, "not_found", "Task source not found for rollback.", {
        availableActions: ["list_my_tasks"]
      });
    }

    this.validateSource(source);

    if (!source.mergedSha) {
      throw new TaskLifecycleError(409, "conflict", "Task has no merged commit to revert.", {
        taskId,
        availableActions: ["get_task"]
      });
    }

    const revertResponse = await this.createRevertCommit(source);
    const prResponse = await this.createPullRequest(source, revertResponse, payload);

    if (source.issueNumber) {
      await this.reopenIssue(source);
    }

    return {
      data: {
        taskId,
        rollbackPrUrl: prResponse.html_url,
        rollbackPrNumber: prResponse.number,
        newHeadSha: revertResponse.sha,
        revertedCommitSha: source.mergedSha,
        status: "rollback_pr_created"
      },
      availableActions: ["get_task"]
    };
  }

  async createRevertCommit(source) {
    const url = `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/git/commits/${source.mergedSha}`;
    const commitResponse = await this.fetchJson(url);

    const parentSha = commitResponse.parents?.[0]?.sha;
    if (!parentSha) {
      throw new RollbackSourceError("Merged commit has no parent to revert to.", {
        statusCode: 409,
        code: "rollback_no_parent",
        details: { mergedSha: source.mergedSha, availableActions: ["get_task"] }
      });
    }

    const treeSha = await this.getTreeForCommit(source, parentSha);

    const newCommit = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: `Revert "${commitResponse.message}"\n\nThis reverts commit ${source.mergedSha}.`,
          tree: treeSha,
          parents: [source.mergedSha]
        })
      }
    );

    return newCommit;
  }

  async getTreeForCommit(source, commitSha) {
    const commit = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/git/commits/${commitSha}`
    );
    return commit.tree.sha;
  }

  async createPullRequest(source, revertCommit, payload) {
    const branch = `rollback/${source.mergedSha.slice(0, 8)}`;
    const baseBranch = source.baseBranch ?? "main";

    await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: revertCommit.sha
        })
      }
    );

    const pr = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Rollback: revert ${source.mergedSha.slice(0, 8)}`,
          body: payload?.reason
            ? `Automated rollback.\n\nReason: ${payload.reason}`
            : "Automated rollback via AgentRail.",
          head: branch,
          base: baseBranch
        })
      }
    );

    return pr;
  }

  async reopenIssue(source) {
    try {
      await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/issues/${source.issueNumber}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state: "open" })
        }
      );
    } catch {
      // Best-effort: don't fail the rollback if issue reopen fails
    }
  }

  lookupTaskSource(taskId) {
    return resolveTaskSource(taskId, {
      taskSources: this.taskSources,
      getTask: this.getTask,
    });
  }

  validateSource(source) {
    for (const field of ["owner", "repo"]) {
      if (typeof source[field] !== "string" || source[field].length === 0) {
        throw new RollbackSourceError(`Task rollback source is missing GitHub ${field}.`, {
          statusCode: 500,
          code: "rollback_source_misconfigured",
          details: { field, availableActions: ["contact_support"] }
        });
      }
    }
  }

  async fetchJson(url: string, options: { method?: string; body?: string } = {}): Promise<any> {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.body ? { "content-type": "application/json" } : {})
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new RollbackSourceError("GitHub rejected the rollback request.", {
          statusCode: 502,
          code: "rollback_source_auth_failed",
          details: { sourceStatus: response.status, availableActions: ["retry"] }
        });
      }
      if (response.status === 404) {
        throw new RollbackSourceError("GitHub resource not found for rollback.", {
          statusCode: 404,
          code: "not_found",
          details: { sourceStatus: response.status, sourceMessage: body.slice(0, 240), availableActions: ["get_task"] }
        });
      }
      if (response.status === 422) {
        throw new RollbackSourceError("GitHub rejected the rollback operation.", {
          statusCode: 422,
          code: "rollback_rejected",
          details: { sourceStatus: response.status, sourceMessage: body.slice(0, 240), availableActions: ["get_task"] }
        });
      }
      throw new RollbackSourceError("GitHub rollback source is unavailable.", {
        details: { sourceStatus: response.status, sourceMessage: body.slice(0, 240), availableActions: ["retry"] }
      });
    }

    return response.json();
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };
    if (this.githubToken) {
      headers.authorization = `Bearer ${this.githubToken}`;
    }
    return headers;
  }
}

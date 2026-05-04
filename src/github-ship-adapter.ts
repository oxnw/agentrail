import { TaskLifecycleError } from "./task-lifecycle-errors.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

export class GitHubShipAdapter {
  declare taskSources: any;
  declare githubToken: string | undefined;
  declare fetch: typeof globalThis.fetch;
  declare apiBaseUrl: string;
  declare delegate: any;
  declare idempotencyRecords: Map<string, any>;
  declare eventStore: any;
  declare now: () => Date;
  declare publicBaseUrl: string;

  constructor({
    taskSources = {},
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
    delegate = null,
    eventStore = null,
    now = () => new Date(),
    publicBaseUrl = "",
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubShipAdapter requires a fetch implementation.");
    }
    this.taskSources = taskSources;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.delegate = delegate;
    this.idempotencyRecords = new Map();
    this.eventStore = eventStore;
    this.now = now;
    this.publicBaseUrl = publicBaseUrl || this.apiBaseUrl;
  }

  async shipTask(taskId: string, payload: unknown, idempotencyKey: string | undefined) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    validateShipPayload(payload);
    const typedPayload = payload as ShipPayload;

    const key = `ship:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const cached = this.idempotencyRecords.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Idempotency-Key has already been used with a different request payload.",
          { idempotencyKey, availableActions: ["retry"] }
        );
      }
      return structuredClone(cached.response);
    }

    const source = lookupTaskSource(this.taskSources, taskId);
    if (!source) {
      if (this.delegate && typeof this.delegate.shipTask === "function") {
        return this.delegate.shipTask(taskId, payload, idempotencyKey);
      }
      throw new TaskLifecycleError(404, "not_found", "No task source configured for this task.", {
        availableActions: ["list_my_tasks"],
      });
    }

    validateSource(source);

    let pr = await this.resolvePullRequest(source, typedPayload.expectedHeadSha);

    if (!pr) {
      throw new TaskLifecycleError(
        404,
        "not_found",
        "No open pull request found for this task with the expected head SHA.",
        { availableActions: ["get_task"] }
      );
    }

    // If PR is already merged, just return the cached/constructed response.
    if (pr.merged === true || (pr.state === "closed" && pr.merge_commit_sha)) {
      const response = buildMergedResponse(taskId, pr, typedPayload, this.publicBaseUrl);
      this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
      return response;
    }

    if (pr.head?.sha !== typedPayload.expectedHeadSha) {
      throw new TaskLifecycleError(409, "conflict", "Task head SHA does not match the open pull request.", {
        expectedHeadSha: typedPayload.expectedHeadSha,
        receivedHeadSha: pr.head?.sha,
        availableActions: ["refresh_task"],
      });
    }

    const mergeMethod = mapMergeMethod(typedPayload.mode);
    const mergeResult = await this.mergePullRequest(source, pr.number, typedPayload, mergeMethod);

    // Refresh PR so we can read merge_commit_sha if it changed
    try {
      pr = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${pr.number}`
      );
    } catch {
      // best-effort refresh
    }

    // Store merged SHA on the source so rollback can use it
    const mergedSha = mergeResult?.sha ?? pr.merge_commit_sha ?? null;
    if (mergedSha) {
      source.mergedSha = mergedSha;
    }

    const response = buildMergedResponse(taskId, pr, typedPayload, this.publicBaseUrl, mergeResult);

    this.idempotencyRecords.set(key, { fingerprint, response: structuredClone(response) });
    await this.appendTaskShippedEvent(taskId, source, response, typedPayload);

    return response;
  }

  async resolvePullRequest(source: any, expectedHeadSha: string) {
    const preferredNumber = source.prNumber ?? source.pullNumber ?? null;
    if (preferredNumber) {
      try {
        const pr = await this.fetchJson(
          `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${preferredNumber}`
        );
        return pr;
      } catch {
        // fall through to search
      }
    }

    // Search open PRs by branch
    if (source.branch) {
      const params = new URLSearchParams({
        state: "open",
        head: `${source.owner}:${source.branch}`,
        per_page: "5",
      });
      const prs = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls?${params}`
      );
      if (Array.isArray(prs) && prs.length > 0) {
        const matching = prs.find((p: any) => p.head?.sha === expectedHeadSha);
        return matching ?? prs[0];
      }
    }

    // Fallback: search open PRs referencing the issue number
    if (source.issueNumber) {
      const params = new URLSearchParams({ state: "open", per_page: "30" });
      const prs = await this.fetchJson(
        `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls?${params}`
      );
      if (Array.isArray(prs)) {
        const matching = prs.find(
          (p: any) =>
            p.head?.sha === expectedHeadSha ||
            (p.body ?? "").includes(`#${source.issueNumber}`)
        );
        return matching ?? null;
      }
    }

    return null;
  }

  async mergePullRequest(source: any, pullNumber: number, _payload: ShipPayload, mergeMethod: string) {
    const url = `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/pulls/${pullNumber}/merge`;
    const response = await this.fetch(url, {
      method: "PUT",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        merge_method: mergeMethod,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 405) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Pull request cannot be merged. It may be blocked by failing checks, pending reviews, or merge conflicts.",
          { availableActions: ["view_ci_status", "view_review_feedback"] }
        );
      }
      if (response.status === 409) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Pull request merge failed due to a state conflict (e.g., head SHA changed).",
          { availableActions: ["refresh_task"] }
        );
      }
      if (response.status === 422) {
        throw new TaskLifecycleError(
          422,
          "validation_error",
          `GitHub rejected the merge: ${text.slice(0, 200)}`,
          { availableActions: ["retry"] }
        );
      }
      throw new TaskLifecycleError(
        502,
        "upstream_error",
        `GitHub merge API error: ${response.status} ${text.slice(0, 200)}`,
        { availableActions: ["retry"] }
      );
    }

    return response.json();
  }

  async fetchJson(url: string): Promise<any> {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new TaskLifecycleError(
        response.status === 404 ? 404 : 502,
        response.status === 404 ? "not_found" : "upstream_error",
        `GitHub API error: ${response.status} ${text.slice(0, 200)}`,
        { availableActions: ["retry"] }
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

  async appendTaskShippedEvent(taskId: string, source: any, response: any, payload: ShipPayload) {
    if (!this.eventStore) return;
    const now = this.now().toISOString();
    try {
      await this.eventStore.append({
        type: "task.shipped",
        occurredAt: now,
        data: {
          taskId,
          taskIdentifier: source.issueNumber ? `#${source.issueNumber}` : taskId,
          status: "done",
          shipStatus: response.data.status,
          operationId: response.data.operationId,
          targetEnvironment: payload.targetEnvironment,
          summary: `Task shipped to ${payload.targetEnvironment}.`,
          availableActions: response.data.availableActions,
          links: {
            task: `${this.publicBaseUrl}/tasks/${taskId}`,
            shipOperation: `${this.publicBaseUrl}/ship-operations/${response.data.operationId}`,
          },
        },
      });
    } catch {
      // best-effort event emission
    }
  }
}

function lookupTaskSource(taskSources: any, taskId: string) {
  if (taskSources instanceof Map) {
    return taskSources.get(taskId) ?? null;
  }
  return taskSources?.[taskId] ?? null;
}

function validateSource(source: any) {
  for (const field of ["owner", "repo"]) {
    if (typeof source[field] !== "string" || source[field].length === 0) {
      throw new TaskLifecycleError(
        500,
        "misconfigured",
        `Task source is missing GitHub ${field}.`,
        { availableActions: ["contact_support"] }
      );
    }
  }
}

interface ShipPayload {
  mode: "merge_only" | "merge_and_deploy";
  targetEnvironment: "staging" | "production";
  expectedHeadSha: string;
}

function validateShipPayload(payload: unknown): asserts payload is ShipPayload {
  if (!payload || typeof payload !== "object") {
    throw new TaskLifecycleError(400, "validation_error", "Request body is required.", {
      availableActions: ["retry"],
    });
  }
  const p = payload as Record<string, unknown>;
  const mode = p.mode;
  if (mode !== "merge_only" && mode !== "merge_and_deploy") {
    throw new TaskLifecycleError(
      400,
      "validation_error",
      "`mode` must be 'merge_only' or 'merge_and_deploy'.",
      { availableActions: ["retry"] }
    );
  }
  const targetEnvironment = p.targetEnvironment;
  if (targetEnvironment !== "staging" && targetEnvironment !== "production") {
    throw new TaskLifecycleError(
      400,
      "validation_error",
      "`targetEnvironment` must be 'staging' or 'production'.",
      { availableActions: ["retry"] }
    );
  }
  const expectedHeadSha = p.expectedHeadSha;
  if (typeof expectedHeadSha !== "string" || !/^[a-f0-9]{40}$/.test(expectedHeadSha)) {
    throw new TaskLifecycleError(
      400,
      "validation_error",
      "`expectedHeadSha` must be a 40-character hex SHA.",
      { availableActions: ["retry"] }
    );
  }
}

function mapMergeMethod(mode: "merge_only" | "merge_and_deploy"): string {
  return "merge";
}

function buildMergedResponse(
  taskId: string,
  pr: any,
  _payload: ShipPayload,
  publicBaseUrl: string,
  mergeResult: any = null
) {
  const mergedSha = mergeResult?.sha ?? pr.merge_commit_sha ?? "";
  const operationId = mergedSha ? `shp_gh_${mergedSha.slice(0, 16)}` : `shp_gh_${pr.number}`;
  const now = new Date().toISOString();
  return {
    data: {
      taskId,
      operationId,
      status: "succeeded",
      queuedAt: now,
      availableActions: ["rollback"],
    },
    availableActions: ["rollback"],
  };
}

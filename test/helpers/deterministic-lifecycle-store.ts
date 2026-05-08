import { TaskLifecycleError } from "../../src/task-lifecycle-errors.ts";

export const DEMO_TASK_ID = "tsk_DEMOISSUETOSHIP01";
export const DEMO_HEAD_SHA = "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:3000";

export function createAgentShipCycleDemoStore(options = {}) {
  return new AgentShipCycleDemoStore(options);
}

class AgentShipCycleDemoStore {
  declare now: () => Date;
  declare eventStore: any;
  declare apiBaseUrl: string;
  declare idempotencyRecords: Map<string, any>;
  declare tasks: Map<string, any>;
  constructor({ now = () => new Date(), eventStore = null, apiBaseUrl = DEFAULT_API_BASE_URL } = {}) {
    this.now = now;
    this.eventStore = eventStore;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.idempotencyRecords = new Map();
    this.tasks = new Map([[DEMO_TASK_ID, createDemoTask(now)]]);
  }

  listMyTasks({ status, limit = 25, cursor = null }: { status?: string; limit?: number; cursor?: string | null } = {}) {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
    const normalizedLimit = Math.min(100, Math.max(1, limit || 25));
    const tasks = [...this.tasks.values()]
      .filter((task) => !status || task.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = tasks.slice(offset, offset + normalizedLimit);
    const nextOffset = offset + normalizedLimit;
    const hasMore = nextOffset < tasks.length;

    return {
      data: page.map(toTaskSummary),
      page: {
        nextCursor: hasMore ? Buffer.from(String(nextOffset)).toString("base64url") : null,
        hasMore
      },
      availableActions: hasMore ? ["fetch_next_page"] : [],
      meta: {
        tokenBudgetHint: "compact"
      }
    };
  }

  getTask(taskId) {
    const task = this.getExistingTask(taskId);
    return {
      data: toTaskDetail(task),
      availableActions: task.availableActions.includes("submit") ? ["submit"] : task.availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: []
      }
    };
  }

  async submitTask(taskId, payload, idempotencyKey) {
    return this.withIdempotency("submit", idempotencyKey, payload, async () => {
      const task = this.getExistingTask(taskId);
      validateSubmitPayload(payload);

      if (!canSubmit(task)) {
        throw new TaskLifecycleError(409, "conflict", "Task is not in a submittable state.", {
          currentStatus: task.status,
          availableActions: task.availableActions
        });
      }

      const previousStatus = task.status;
      const submissionNumber = task.submissions.length + 1;
      const submissionId =
        submissionNumber === 1 ? "sub_DEMOFIRSTSUBMIT01" : "sub_DEMOSECONDSUBMIT";
      task.submissions.push({
        id: submissionId,
        summary: payload.summary,
        artifacts: payload.artifacts,
        checks: payload.checks ?? [],
        notes: payload.notes ?? null,
        submittedAt: this.now().toISOString()
      });
      task.latestSubmissionId = submissionId;
      task.status = "in_review";
      task.updatedAt = this.now().toISOString();

      if (submissionNumber === 1) {
        task.ciStatus = "failed";
        task.reviewOutcome = "changes_requested";
        task.availableActions = ["submit", "view_ci_status", "view_review_feedback"];
      } else {
        task.ciStatus = "passed";
        task.reviewOutcome = "approved";
        task.availableActions = ["ship", "view_ci_status", "view_review_feedback"];
      }

      await this.appendTaskUpdatedEvent(task, {
        previousStatus,
        summary:
          submissionNumber === 1
            ? "Submission accepted; CI and review feedback require a fix."
            : "Resubmission accepted; CI is green and review is approved."
      });

      return {
        data: {
          submissionId,
          taskId,
          status: "in_review",
          reviewRoute: {
            participants: [{ id: "agt_cto", role: "cto" }]
          },
          acceptedAt: this.now().toISOString(),
          availableActions: ["view_review_feedback", "view_ci_status"]
        },
        availableActions: ["view_review_feedback"]
      };
    });
  }

  getTaskCiStatus(taskId) {
    const task = this.getExistingTask(taskId);
    const status = task.ciStatus ?? "queued";
    const failed = status === "failed";
    const passed = status === "passed";

    return {
      data: {
        taskId,
        submissionId: task.latestSubmissionId,
        overallStatus: status,
        summary: {
          total: task.latestSubmissionId ? 2 : 0,
          passed: passed ? 2 : 0,
          failed: failed ? 1 : 0,
          running: failed ? 1 : 0,
          queued: task.latestSubmissionId ? 0 : 2,
          cancelled: 0,
          skipped: 0
        },
        workflows: [
          {
            name: "CI",
            path: ".github/workflows/ci.yml",
            status,
            passed: passed ? 2 : 0,
            failed: failed ? 1 : 0,
            running: failed ? 1 : 0,
            queued: task.latestSubmissionId ? 0 : 2,
            cancelled: 0,
            skipped: 0,
            url: "https://github.com/oxnw/agentrail/actions/runs/4242"
          }
        ],
        checks: createCiChecks(status),
        failureSummaries: failed
          ? [
              {
                checkName: "unit-tests",
                workflow: "CI",
                testName: "POST /tasks/{id}/ship rejects non-idempotent retries",
                file: "src/app.js",
                line: 211,
                message: "Idempotency-Key reuse returned 202 for a different payload."
              }
            ]
          : [],
        flakyHints: [],
        updatedAt: task.updatedAt,
        availableActions: passed ? ["view_review_feedback"] : ["view_review_feedback", "submit"]
      },
      availableActions: passed ? ["view_review_feedback"] : ["view_review_feedback", "submit"],
      meta: {
        tokenBudgetHint: failed ? "standard" : "compact",
        truncatedFields: []
      }
    };
  }

  getTaskReviewFeedback(taskId) {
    const task = this.getExistingTask(taskId);
    const approved = task.reviewOutcome === "approved";
    const changesRequested = task.reviewOutcome === "changes_requested";

    return {
      data: {
        taskId,
        latestDecision: {
          outcome: task.reviewOutcome ?? "pending",
          reviewer: { id: "agt_cto", role: "cto" },
          createdAt: task.updatedAt,
          summary: approved
            ? "Approved for ship after CI passed and idempotency coverage was added."
            : changesRequested
              ? "Fix ship idempotency before this can merge."
              : "Review is waiting for the first submission."
        },
        comments: changesRequested
          ? [
              {
                id: "cmt_DEMOFIXIDEMPOTENCY",
                authorRole: "cto",
                body: "POST /tasks/{id}/ship must reject reused idempotency keys with different payloads.",
                severity: "must_fix",
                file: "src/app.js",
                line: 211,
                suggestedAction: "Return 409 conflict with the original Idempotency-Key."
              }
            ]
          : [],
        availableActions: approved ? ["ship"] : ["submit"]
      },
      availableActions: approved ? ["ship"] : ["submit"]
    };
  }

  async shipTask(taskId, payload, idempotencyKey) {
    return this.withIdempotency("ship", idempotencyKey, payload, async () => {
      const task = this.getExistingTask(taskId);
      validateShipPayload(payload);

      if (payload.expectedHeadSha !== DEMO_HEAD_SHA) {
        throw new TaskLifecycleError(409, "conflict", "Task head SHA does not match.", {
          expectedHeadSha: DEMO_HEAD_SHA,
          receivedHeadSha: payload.expectedHeadSha,
          availableActions: ["refresh_task"]
        });
      }

      if (task.ciStatus !== "passed" || task.reviewOutcome !== "approved") {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Task cannot be shipped until CI is green and review is approved.",
          {
            currentStatus: task.status,
            ciStatus: task.ciStatus ?? "queued",
            reviewStatus: task.reviewOutcome ?? "pending",
            availableActions: ["view_ci_status", "view_review_feedback"]
          }
        );
      }

      const operationId = "shp_DEMOSHIPOPERATION1";
      const previousStatus = task.status;
      task.status = "done";
      task.availableActions = ["rollback"];
      task.updatedAt = this.now().toISOString();
      task.shipOperation = {
        id: operationId,
        status: "queued",
        targetEnvironment: payload.targetEnvironment,
        mode: payload.mode,
        queuedAt: task.updatedAt
      };

      await this.appendTaskShippedEvent(task, { previousStatus });

      return {
        data: {
          taskId,
          operationId,
          status: "queued",
          queuedAt: task.updatedAt,
          availableActions: ["rollback"]
        },
        availableActions: ["rollback"]
      };
    });
  }

  async rollbackTask(taskId, payload, idempotencyKey) {
    return this.withIdempotency("rollback", idempotencyKey, payload, async () => {
      const task = this.getExistingTask(taskId);

      if (task.status !== "done" || !task.shipOperation) {
        throw new TaskLifecycleError(409, "conflict", "Task is not in a shipped state.", {
          currentStatus: task.status,
          availableActions: task.availableActions
        });
      }

      const previousStatus = task.status;
      const rollbackSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
      task.status = "rolled_back";
      task.availableActions = ["submit"];
      task.updatedAt = this.now().toISOString();
      task.rollbackOperation = {
        revertedCommitSha: DEMO_HEAD_SHA,
        newHeadSha: rollbackSha,
        rollbackPrUrl: "https://github.com/oxnw/agentrail/pull/99",
        rollbackPrNumber: 99,
        reason: payload?.reason ?? null,
        rolledBackAt: task.updatedAt
      };

      await this.appendTaskRolledBackEvent(task, { previousStatus });

      return {
        data: {
          taskId,
          rollbackPrUrl: task.rollbackOperation.rollbackPrUrl,
          rollbackPrNumber: task.rollbackOperation.rollbackPrNumber,
          newHeadSha: rollbackSha,
          revertedCommitSha: DEMO_HEAD_SHA,
          status: "rollback_pr_created"
        },
        availableActions: ["get_task"]
      };
    });
  }

  getExistingTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"]
      });
    }
    return task;
  }

  async withIdempotency(scope, idempotencyKey, payload, operation) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"]
      });
    }

    const key = `${scope}:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const existing = this.idempotencyRecords.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(
          409,
          "conflict",
          "Idempotency-Key has already been used with a different request payload.",
          {
            idempotencyKey,
            availableActions: ["retry"]
          }
        );
      }

      return structuredClone(existing.response);
    }

    const response = await operation();
    this.idempotencyRecords.set(key, {
      fingerprint,
      response: structuredClone(response)
    });
    return response;
  }

  async appendTaskUpdatedEvent(task, { previousStatus, summary }) {
    if (!this.eventStore) {
      return;
    }

    await this.eventStore.append({
      id: `evt_DEMOTASKUPDATED${String(this.eventStore.getMaxSequence() + 1).padStart(2, "0")}`,
      type: "task.updated",
      occurredAt: this.now().toISOString(),
      taskVersion: task.submissions.length + 1,
      traceId: null,
      data: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        status: task.status,
        previousStatus,
        changedFields: ["status", "availableActions"],
        actor: {
          id: task.assignee.id,
          role: "agent"
        },
        summary,
        availableActions: task.availableActions,
        links: eventLinks(task, this.apiBaseUrl)
      }
    });
  }

  async appendTaskShippedEvent(task: any, _opts?: Record<string, unknown>) {
    if (!this.eventStore) {
      return;
    }

    await this.eventStore.append({
      id: `evt_DEMOTASKSHIPPED${String(this.eventStore.getMaxSequence() + 1).padStart(2, "0")}`,
      type: "task.shipped",
      occurredAt: this.now().toISOString(),
      taskVersion: task.submissions.length + 2,
      traceId: null,
      data: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        status: task.status,
        shipStatus: task.shipOperation.status,
        operationId: task.shipOperation.id,
        targetEnvironment: task.shipOperation.targetEnvironment,
        summary: "Ship request accepted for merge and deploy.",
        availableActions: task.availableActions,
        links: eventLinks(task, this.apiBaseUrl)
      }
    });
  }

  async appendTaskRolledBackEvent(task, { previousStatus }) {
    if (!this.eventStore) {
      return;
    }

    await this.eventStore.append({
      id: `evt_DEMOTASKROLLEDBACK${String(this.eventStore.getMaxSequence() + 1).padStart(2, "0")}`,
      type: "task.rolled_back",
      occurredAt: this.now().toISOString(),
      taskVersion: task.submissions.length + 3,
      traceId: null,
      data: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        status: task.status,
        previousStatus,
        rollbackPrUrl: task.rollbackOperation.rollbackPrUrl,
        newHeadSha: task.rollbackOperation.newHeadSha,
        revertedCommitSha: task.rollbackOperation.revertedCommitSha,
        summary: "Task rolled back via revert PR.",
        availableActions: task.availableActions,
        links: eventLinks(task, this.apiBaseUrl)
      }
    });
  }
}

function createDemoTask(now) {
  return {
    id: DEMO_TASK_ID,
    identifier: "AGEA-10-DEMO",
    title: "Fix idempotent ship retry handling",
    description:
      "Implement and verify idempotent retry semantics for the ship endpoint so agent submissions can be safely retried.",
    status: "in_progress",
    priority: "medium",
    dueAt: null,
    assignee: {
      id: "agt_claude_code",
      name: "Claude Code"
    },
    acceptanceCriteria: [
      "POST /tasks/{id}/ship is safe to retry with the same Idempotency-Key.",
      "Different payload reuse returns 409 conflict.",
      "CI summary and review feedback stay accessible from the task lifecycle API."
    ],
    links: {
      issue: "https://github.com/oxnw/agentrail/issues/10",
      parentIssue: "https://github.com/oxnw/agentrail/issues/9"
    },
    context: {
      project: "agentrail-service",
      goal: "Show issue to ship workflow through AgentRail"
    },
    updatedAt: now().toISOString(),
    availableActions: ["submit"],
    submissions: [],
    latestSubmissionId: null,
    ciStatus: null,
    reviewOutcome: null,
    shipOperation: null
  };
}

function toTaskSummary(task) {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    updatedAt: task.updatedAt,
    availableActions: task.availableActions.filter((action) => ["start", "submit", "ship"].includes(action))
  };
}

function toTaskDetail(task) {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    acceptanceCriteria: task.acceptanceCriteria,
    links: task.links,
    context: task.context,
    updatedAt: task.updatedAt,
    availableActions: task.availableActions
  };
}

function createCiChecks(status) {
  if (status === "passed") {
    return [
      {
        name: "unit-tests",
        workflow: "CI",
        status: "passed",
        url: "https://github.com/oxnw/agentrail/actions/runs/4242/job/1",
        durationSeconds: 22,
        failureCount: 0
      },
      {
        name: "contract-tests",
        workflow: "CI",
        status: "passed",
        url: "https://github.com/oxnw/agentrail/actions/runs/4242/job/2",
        durationSeconds: 18,
        failureCount: 0
      }
    ];
  }

  if (status === "failed") {
    return [
      {
        name: "unit-tests",
        workflow: "CI",
        status: "failed",
        url: "https://github.com/oxnw/agentrail/actions/runs/4242/job/1",
        durationSeconds: 17,
        failureCount: 1
      },
      {
        name: "contract-tests",
        workflow: "CI",
        status: "running",
        url: "https://github.com/oxnw/agentrail/actions/runs/4242/job/2",
        durationSeconds: null,
        failureCount: 0
      }
    ];
  }

  return [];
}

function canSubmit(task) {
  if (["todo", "in_progress"].includes(task.status)) {
    return true;
  }

  return task.status === "in_review" && task.reviewOutcome === "changes_requested";
}

function validateSubmitPayload(payload) {
  if (!payload.summary || typeof payload.summary !== "string") {
    throw new TaskLifecycleError(400, "validation_error", "`summary` is required.", {
      availableActions: ["retry"]
    });
  }

  if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) {
    throw new TaskLifecycleError(400, "validation_error", "`artifacts` must include at least one item.", {
      availableActions: ["retry"]
    });
  }
}

function validateShipPayload(payload) {
  if (!["merge_only", "merge_and_deploy"].includes(payload.mode)) {
    throw new TaskLifecycleError(400, "validation_error", "`mode` is invalid.", {
      availableActions: ["retry"]
    });
  }

  if (!["staging", "production"].includes(payload.targetEnvironment)) {
    throw new TaskLifecycleError(400, "validation_error", "`targetEnvironment` is invalid.", {
      availableActions: ["retry"]
    });
  }

  if (!/^[a-f0-9]{40}$/.test(payload.expectedHeadSha ?? "")) {
    throw new TaskLifecycleError(400, "validation_error", "`expectedHeadSha` must be a 40 character SHA.", {
      availableActions: ["retry"]
    });
  }
}

function eventLinks(task, apiBaseUrl = DEFAULT_API_BASE_URL) {
  return {
    task: `${apiBaseUrl}/tasks/${task.id}`,
    reviewFeedback: `${apiBaseUrl}/tasks/${task.id}/review-feedback`,
    ciStatus: `${apiBaseUrl}/tasks/${task.id}/ci-status`,
    shipOperation: task.shipOperation
      ? `${apiBaseUrl}/ship-operations/${task.shipOperation.id}`
      : null
  };
}

import crypto from "node:crypto";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { TaskStore, type CiOverallStatus, type TaskBlocker, type TaskCiState, type TaskRecord } from "./task-store.ts";
import type { TaskEventStore } from "./task-event-store.ts";
import { getLatestTaskSubmission } from "./task-source-resolution.ts";
import { mergeTaskSource, validateTaskSourceRepairRequest, type TaskSourceRepairRequest } from "./task-source-repair.ts";
import { logNarrative } from "./structured-logger.ts";
import type { RepoTaskSource } from "./task-source.ts";

export interface AgentTaskQueueOptions {
  now?: () => Date;
  storagePath?: string;
  eventStore?: TaskEventStore | null;
  apiBaseUrl?: string;
  delegate?: TaskLifecycleDelegate | null;
}

export interface TaskLifecycleDelegate {
  submitTask?(taskId: string, payload: unknown, idempotencyKey: string | undefined): Promise<unknown>;
  shipTask?(taskId: string, payload: unknown, idempotencyKey: string | undefined): Promise<unknown>;
  rollbackTask?(taskId: string, payload: unknown, idempotencyKey: string | undefined): Promise<unknown>;
}

interface TaskSourceRepairResponseBody {
  data: {
    taskId: string;
    source: NonNullable<TaskRecord["source"]>;
    sourceAudit: NonNullable<TaskRecord["sourceAudit"]>;
    updatedAt: string;
    version: number;
  };
  availableActions: string[];
}

function toTaskDetail(task: TaskRecord) {
  const latestSubmission = getLatestTaskSubmission(task);
  const hasStoredAssigneeAgentId = Object.prototype.hasOwnProperty.call(task, "assigneeAgentId");

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
    submissionId: task.latestSubmissionId,
    ci: task.ci ?? null,
    prUrl: latestSubmission?.prUrl ?? task.source?.prUrl ?? null,
    prNumber: latestSubmission?.prNumber ?? task.source?.pullNumber ?? null,
    branch: latestSubmission?.branch ?? task.source?.branch ?? null,
    baseBranch: latestSubmission?.baseBranch ?? task.source?.baseBranch ?? null,
    headSha: latestSubmission?.headSha ?? task.source?.headSha ?? null,
    availableActions: task.availableActions,
    blocker: task.blocker ?? null,
    assigneeAgentId: hasStoredAssigneeAgentId ? task.assigneeAgentId ?? null : task.assignee.id,
    triageQueueId: task.triageQueueId ?? null,
    assignmentSource: task.assignmentSource ?? null,
    routingDecisionId: task.routingDecisionId ?? null,
    routingReason: task.routingReason ?? null,
    routingConfidence: task.routingConfidence ?? null,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function canonicalAssigneeAgentId(task: TaskRecord): string | null {
  return Object.prototype.hasOwnProperty.call(task, "assigneeAgentId")
    ? task.assigneeAgentId ?? null
    : task.assignee.id ?? null;
}

function canStartTask(task: TaskRecord): boolean {
  return task.status === "todo" && task.availableActions.includes("start");
}

function canShipTask(task: TaskRecord): boolean {
  return task.status === "in_review" && task.availableActions.includes("ship");
}

function requireNonEmptyStringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskLifecycleError(400, "validation_error", `${field} must be a non-empty string.`, {
      field,
      availableActions: ["retry"],
    });
  }
  return value.trim();
}

export class AgentTaskQueue {
  private store: TaskStore;
  private now: () => Date;
  private eventStore: TaskEventStore | null;
  private apiBaseUrl: string;
  private delegate: TaskLifecycleDelegate | null;

  constructor({
    now = () => new Date(),
    storagePath,
    eventStore = null,
    apiBaseUrl = "http://127.0.0.1:3000",
    delegate = null,
  }: AgentTaskQueueOptions = {}) {
    this.now = now;
    this.store = new TaskStore({ now, storagePath });
    this.eventStore = eventStore;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.delegate = delegate;
  }

  listMyTasks({
    status,
    assigneeAgentId,
    limit,
    cursor,
  }: {
    status?: string;
    assigneeAgentId?: string;
    limit?: number;
    cursor?: string | null;
  }) {
    return this.store.listTasks({ status, assigneeAgentId, limit, cursor });
  }

  getTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }
    return {
      data: toTaskDetail(task),
      availableActions: task.availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: [],
      },
    };
  }

  async startTask(taskId: string, payload: unknown, idempotencyKey: string | undefined, actorId: string | null | undefined) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    if (!actorId) {
      throw new TaskLifecycleError(403, "forbidden", "Task start requires an agent-scoped API key.", {
        availableActions: ["list_my_tasks"],
      });
    }

    const existing = this.store.getTask(taskId);
    if (!existing) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }

    if (canonicalAssigneeAgentId(existing) !== actorId) {
      throw new TaskLifecycleError(403, "forbidden", "Task is not assigned to this agent.", {
        availableActions: ["list_my_tasks"],
      });
    }

    const key = `start:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ taskId, payload: payload ?? {}, actorId });
    const prior = this.store.getIdempotencyEntry(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different request payload.", {
          idempotencyKey,
          availableActions: ["retry"],
        });
      }
      return structuredClone(prior.response);
    }

    if (!canStartTask(existing)) {
      throw new TaskLifecycleError(409, "conflict", "Task is not in a startable state.", {
        currentStatus: existing.status,
        availableActions: existing.availableActions,
      });
    }

    const updated = this.store.updateTask(taskId, {
      status: "in_progress",
      availableActions: ["submit"],
      updatedAt: this.now().toISOString(),
    });
    if (!updated) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to start task.", {
        availableActions: ["retry"],
      });
    }

    const response = {
      data: toTaskDetail(updated),
      availableActions: updated.availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: [],
      },
    };

    try {
      await this.appendTaskEvent("task.updated", updated, {
        status: updated.status,
        previousStatus: existing.status,
        changedFields: ["status", "availableActions", "updatedAt"],
        actor: { id: actorId, role: "agent" },
        summary: "Task started.",
        availableActions: updated.availableActions,
      });
    } catch (error) {
      try {
        this.store.upsertTask(existing);
      } catch (rollbackError) {
        logNarrative({
          title: "Task Start Rollback Failed",
          message: `Failed to restore task ${taskId} after task event append failed.`,
          operation: "task_start_rollback_failed",
          taskId,
          details: {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        });
      }
      throw error;
    }
    this.store.setIdempotencyEntry(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  async blockTaskAwaitingUser(
    taskId: string,
    payload: unknown,
    idempotencyKey: string | undefined,
    sourceAgentId: string | null | undefined,
  ) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    const payloadObject = asObject(payload);
    if (!payloadObject) {
      throw new TaskLifecycleError(400, "validation_error", "Blocker payload must be a JSON object.", {
        availableActions: ["retry"],
      });
    }

    const sourceRunId = requireNonEmptyStringField(payloadObject, "sourceRunId");
    const resolvedSourceAgentId = requireNonEmptyStringField(payloadObject, "sourceAgentId");
    const authenticatedSourceAgentId = typeof sourceAgentId === "string" && sourceAgentId.trim().length > 0
      ? sourceAgentId.trim()
      : null;
    if (authenticatedSourceAgentId && authenticatedSourceAgentId !== resolvedSourceAgentId) {
      throw new TaskLifecycleError(403, "forbidden", "Task blocker sourceAgentId must match the authenticated agent.", {
        availableActions: ["list_my_tasks"],
      });
    }
    const reason = requireNonEmptyStringField(payloadObject, "reason");
    const actionRequired = requireNonEmptyStringField(payloadObject, "actionRequired");
    const resumeInstructions = requireNonEmptyStringField(payloadObject, "resumeInstructions");

    const key = `block-task-awaiting-user:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ taskId, sourceRunId, sourceAgentId: resolvedSourceAgentId, reason, actionRequired, resumeInstructions });
    const prior = this.store.getIdempotencyEntry(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different blocker payload.", {
          idempotencyKey,
          availableActions: ["retry"],
        });
      }
      return structuredClone(prior.response);
    }

    const existing = this.store.getTask(taskId);
    if (!existing) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }

    const assigneeAgentId = canonicalAssigneeAgentId(existing);
    if (resolvedSourceAgentId && assigneeAgentId && assigneeAgentId !== resolvedSourceAgentId) {
      throw new TaskLifecycleError(403, "forbidden", "Task is not assigned to this agent.", {
        availableActions: ["list_my_tasks"],
      });
    }
    if (existing.status !== "in_progress") {
      throw new TaskLifecycleError(409, "conflict", "Task is not in a blockable state.", {
        currentStatus: existing.status,
        availableActions: existing.availableActions,
      });
    }

    const blocker: TaskBlocker = {
      kind: "awaiting_user",
      sourceRunId,
      sourceAgentId: resolvedSourceAgentId,
      reason,
      actionRequired,
      resumeInstructions,
      createdAt: this.now().toISOString(),
    };

    const updated = this.store.updateTask(taskId, {
      status: "blocked",
      availableActions: ["resolve_blocker"],
      blocker,
      updatedAt: this.now().toISOString(),
    });
    if (!updated) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to block task.", {
        availableActions: ["retry"],
      });
    }

    const response = {
      data: toTaskDetail(updated),
      availableActions: updated.availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: [],
      },
    };

    try {
      await this.appendTaskEvent("task.updated", updated, {
        status: updated.status,
        previousStatus: existing.status,
        changedFields: ["status", "availableActions", "blocker", "updatedAt"],
        actor: { id: resolvedSourceAgentId, role: "agent" },
        summary: "Task blocked awaiting user input.",
        availableActions: updated.availableActions,
        blocker: updated.blocker,
      });
      await this.appendTaskEvent("task.awaiting_user", updated, {
        status: updated.status,
        previousStatus: existing.status,
        changedFields: ["status", "availableActions", "blocker", "updatedAt"],
        actor: { id: resolvedSourceAgentId, role: "agent" },
        summary: "Task is awaiting user input.",
        availableActions: updated.availableActions,
        blocker: updated.blocker,
      });
    } catch (error) {
      try {
        this.store.upsertTask(existing);
      } catch (rollbackError) {
        logNarrative({
          title: "Task Blocker Rollback Failed",
          message: `Failed to restore task ${taskId} after task event append failed.`,
          operation: "task_blocker_rollback_failed",
          taskId,
          details: {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        });
      }
      throw error;
    }

    this.store.setIdempotencyEntry(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  async resolveBlocker(
    taskId: string,
    payload: unknown,
    idempotencyKey: string | undefined,
    actorId: string | null | undefined,
    actorRole = "system",
  ) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    const payloadObject = asObject(payload);
    if (!payloadObject) {
      throw new TaskLifecycleError(400, "validation_error", "Resolution payload must be a JSON object.", {
        availableActions: ["retry"],
      });
    }
    const resolutionSummary = requireNonEmptyStringField(payloadObject, "resolutionSummary");

    const key = `resolve-task-blocker:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ taskId, resolutionSummary, actorId: actorId ?? null, actorRole });
    const prior = this.store.getIdempotencyEntry(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different blocker resolution payload.", {
          idempotencyKey,
          availableActions: ["retry"],
        });
      }
      return structuredClone(prior.response);
    }

    const existing = this.store.getTask(taskId);
    if (!existing) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }

    if (existing.status !== "blocked" || existing.blocker?.kind !== "awaiting_user") {
      throw new TaskLifecycleError(409, "conflict", "Task does not have an awaiting-user blocker to resolve.", {
        currentStatus: existing.status,
        availableActions: existing.availableActions,
      });
    }

    const updated = this.store.updateTask(taskId, {
      status: "todo",
      availableActions: ["start"],
      blocker: null,
      updatedAt: this.now().toISOString(),
    });
    if (!updated) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to resolve task blocker.", {
        availableActions: ["retry"],
      });
    }

    const response = {
      data: toTaskDetail(updated),
      availableActions: updated.availableActions,
      meta: {
        tokenBudgetHint: "standard",
        truncatedFields: [],
      },
    };

    try {
      await this.appendTaskEvent("task.updated", updated, {
        status: updated.status,
        previousStatus: existing.status,
        changedFields: ["status", "availableActions", "blocker", "updatedAt"],
        actor: { id: actorId ?? "system", role: actorRole },
        summary: "Task blocker resolved.",
        resolutionSummary,
        availableActions: updated.availableActions,
        blocker: null,
      });
    } catch (error) {
      try {
        this.store.upsertTask(existing);
      } catch (rollbackError) {
        logNarrative({
          title: "Task Blocker Resolve Rollback Failed",
          message: `Failed to restore task ${taskId} after task blocker event append failed.`,
          operation: "task_blocker_resolve_rollback_failed",
          taskId,
          details: {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        });
      }
      throw error;
    }

    this.store.setIdempotencyEntry(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  async submitTask(taskId: string, payload: unknown, idempotencyKey: string | undefined) {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    if (!this.delegate?.submitTask) {
      throw new TaskLifecycleError(501, "not_implemented", "Task submission is not supported by the current runtime configuration.", {
        availableActions: ["list_my_tasks"],
      });
    }

    const key = `submit:${idempotencyKey}`;
    const fingerprint = JSON.stringify(payload);
    const existing = this.store.getIdempotencyEntry(key);
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

    const response = await this.delegate.submitTask(taskId, payload, idempotencyKey);
    const responseData = (response as any)?.data;

    // Persist PR metadata onto the live task record
    const task = this.store.getTask(taskId);
    if (task && responseData?.submissionId) {
      const previousStatus = task.status;
      const payloadObject = asObject(payload) ?? {};
      const pullRequest = asObject(payloadObject.pullRequest) ?? {};
      const branch = firstString(pullRequest.head, payloadObject.head, responseData.head, task.source?.branch);
      const baseBranch = firstString(pullRequest.base, payloadObject.base, responseData.base, task.source?.baseBranch);
      const headSha = firstString(pullRequest.headSha, payloadObject.headSha, responseData.headSha, task.source?.headSha);
      const newSubmission = {
        id: responseData.submissionId,
        summary: typeof payloadObject.summary === "string" ? payloadObject.summary : "",
        artifacts: Array.isArray(payloadObject.artifacts) ? payloadObject.artifacts : [],
        checks: Array.isArray(payloadObject.checks) ? payloadObject.checks : [],
        notes: typeof payloadObject.notes === "string" ? payloadObject.notes : null,
        submittedAt: this.now().toISOString(),
        prUrl: responseData.prUrl ?? null,
        prNumber: responseData.prNumber ?? null,
        branch: branch ?? null,
        baseBranch: baseBranch ?? null,
        headSha: headSha ?? null,
      };
      const submissions = [...task.submissions, newSubmission];
      const latestSubmissionId = responseData.submissionId;
      const status: TaskRecord["status"] = "in_review";
      const availableActions = ["ship", "view_ci_status", "view_review_feedback"];
      const source = task.source
        ? {
            ...task.source,
            submissionId: responseData.submissionId,
            pullNumber: responseData.prNumber ?? task.source.pullNumber,
            prUrl: responseData.prUrl ?? task.source.prUrl,
            branch: branch ?? task.source.branch,
            baseBranch: baseBranch ?? task.source.baseBranch,
            headSha: headSha ?? task.source.headSha,
          }
        : undefined;

      const updated = this.store.updateTask(taskId, {
        submissions,
        latestSubmissionId,
        status,
        availableActions,
        source,
        updatedAt: this.now().toISOString(),
      });

      if (updated) {
        await this.appendTaskUpdatedEvent(updated, {
          previousStatus,
          summary: `Submission accepted: ${responseData.submissionId}${responseData.prNumber ? ` (PR #${responseData.prNumber})` : ""}`,
        });
      }
    }

    this.store.setIdempotencyEntry(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  async shipTask(taskId: string, payload: unknown, idempotencyKey: string | undefined) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }
    if (!canShipTask(task)) {
      throw new TaskLifecycleError(409, "conflict", "Task is not in a shippable state.", {
        currentStatus: task.status,
        availableActions: task.availableActions,
      });
    }
    if (this.delegate?.shipTask) {
      return this.delegate.shipTask(taskId, payload, idempotencyKey);
    }
    throw new TaskLifecycleError(501, "not_implemented", "Task ship is not supported by the current runtime configuration.", {
      availableActions: ["list_my_tasks"],
    });
  }

  async rollbackTask(taskId: string, payload: unknown, idempotencyKey: string | undefined) {
    if (this.delegate?.rollbackTask) {
      return this.delegate.rollbackTask(taskId, payload, idempotencyKey);
    }
    throw new TaskLifecycleError(501, "not_implemented", "Task rollback is not supported by the current runtime configuration.", {
      availableActions: ["list_my_tasks"],
    });
  }

  repairTaskSource(
    taskId: string,
    payload: TaskSourceRepairRequest,
    updatedBy: string,
    idempotencyKey: string | undefined,
  ): TaskSourceRepairResponseBody {
    if (!idempotencyKey) {
      throw new TaskLifecycleError(400, "validation_error", "Idempotency-Key header is required.", {
        availableActions: ["retry"],
      });
    }

    const validated = validateTaskSourceRepairRequest(payload);
    const existing = this.store.getTask(taskId);
    if (!existing) {
      throw new TaskLifecycleError(404, "not_found", "Task not found.", {
        availableActions: ["list_my_tasks"],
      });
    }

    const key = `repair-task-source:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ taskId, payload: validated, updatedBy });
    const prior = this.store.getIdempotencyEntry(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different task source repair payload.", {
          idempotencyKey,
          availableActions: ["retry"],
        });
      }
      return structuredClone(prior.response as TaskSourceRepairResponseBody);
    }

    const mergedSource = mergeTaskSource({
      currentSource: existing.source,
      patch: validated.source,
    });
    const updated = this.store.updateTask(taskId, {
      source: mergedSource,
      sourceAudit: {
        sourceRef: validated.sourceRef,
        changeReason: validated.changeReason,
        updatedBy,
        updatedAt: this.now().toISOString(),
      },
    });

    if (!updated?.source || !updated.sourceAudit) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to persist repaired task source.", {
        availableActions: ["retry"],
      });
    }

    const response = {
      data: {
        taskId: updated.id,
        source: structuredClone(updated.source),
        sourceAudit: structuredClone(updated.sourceAudit),
        updatedAt: updated.updatedAt,
        version: updated.version,
      },
      availableActions: ["get_task"],
    };

    this.store.setIdempotencyEntry(key, { fingerprint, response: structuredClone(response) });
    return response;
  }

  // Internal helpers for store management (used by intake/routing engine and tests)
  createTask(partial: Parameters<TaskStore["createTask"]>[0]) {
    return this.store.createTask(partial);
  }

  updateTask(taskId: string, patch: Parameters<TaskStore["updateTask"]>[1]) {
    return this.store.updateTask(taskId, patch);
  }

  deleteTask(taskId: string) {
    return this.store.deleteTask(taskId);
  }

  getRawTask(taskId: string) {
    return this.store.getTask(taskId);
  }

  findTaskByIdentifier(identifier: string) {
    return this.store.findTaskByIdentifier(identifier);
  }

  findTaskByLinearIssueId(issueId: string) {
    return this.store.findTaskByLinearIssueId(issueId);
  }

  findTasksByLinearIssueId(issueId: string) {
    return this.store.findTasksByLinearIssueId(issueId);
  }

  getIdempotencyEntry(key: string) {
    return this.store.getIdempotencyEntry(key);
  }

  setIdempotencyEntry(key: string, entry: Parameters<TaskStore["setIdempotencyEntry"]>[1]) {
    return this.store.setIdempotencyEntry(key, entry);
  }

  listRawTasks() {
    return this.store.listAllTasks();
  }

  countActiveAssignedTasks({
    agentId,
    statuses,
    excludeTaskId,
    excludeTask,
    stopAt,
  }: {
    agentId: string;
    statuses: ReadonlySet<string>;
    excludeTaskId?: string;
    excludeTask?: (task: TaskRecord) => boolean;
    stopAt?: number;
  }) {
    return this.store.countTasks((task) => {
      if (task.id === excludeTaskId) {
        return false;
      }
      const isExcluded = excludeTask?.(task) ?? false;
      return canonicalAssigneeAgentId(task) === agentId
        && statuses.has(task.status)
        && !isExcluded;
    }, stopAt);
  }

  listRawTasksBySourceRepo(provider: RepoTaskSource["provider"], owner: string, repo: string) {
    return this.store.findTasksBySourceRepo(provider, owner, repo);
  }

  async projectCiState(taskId: string, observation: {
    provider: string;
    overallStatus: CiOverallStatus;
    summary?: Partial<TaskCiState["summary"]> | null;
    headline?: string | null;
    updatedAt?: string | null;
  }): Promise<{ task: TaskRecord; outcome: "failed_transition" | "recovered_transition" | "unchanged" } | null> {
    const existing = this.store.getTask(taskId);
    if (!existing) {
      return null;
    }
    const previousTaskStatus = existing.status;
    const previousCiStatus = existing.ci?.overallStatus ?? existing.ciStatus ?? null;
    const nextStatus = observation.overallStatus;
    const blocking = nextStatus === "failed";
    const nowIso = this.now().toISOString();
    const ci: TaskCiState = {
      provider: observation.provider,
      overallStatus: nextStatus,
      blocking,
      summary: {
        total: toSafeNumber(observation.summary?.total),
        passed: toSafeNumber(observation.summary?.passed),
        failed: toSafeNumber(observation.summary?.failed),
        running: toSafeNumber(observation.summary?.running),
        queued: toSafeNumber(observation.summary?.queued),
        cancelled: toSafeNumber(observation.summary?.cancelled),
        skipped: toSafeNumber(observation.summary?.skipped),
        neutral: toSafeNumber(observation.summary?.neutral),
      },
      headline: observation.headline ?? null,
      updatedAt: observation.updatedAt ?? nowIso,
      lastTransitionAt: crossedFailureBoundary(previousCiStatus, nextStatus)
        ? nowIso
        : existing.ci?.lastTransitionAt ?? null,
    };
    const updated = this.store.updateTask(taskId, {
      ciStatus: nextStatus,
      ci,
    });
    if (!updated) {
      return null;
    }
    if (crossedIntoFailure(previousCiStatus, nextStatus)) {
      logNarrative({
        title: "CI Failed",
        message: `${formatTaskLabel(updated)} is blocked by ${formatCiProvider(ci.provider)}${ci.headline ? `: ${ci.headline}` : ""}`,
        operation: "task_ci_failed",
        taskId: updated.id,
        provider: ci.provider,
      });
      await this.appendTaskEvent("task.ci_failed", updated, {
        status: updated.status,
        previousStatus: previousTaskStatus,
        changedFields: ["ciStatus", "ci"],
        actor: { id: "system", role: "system" },
        summary: ci.headline ?? `${ci.provider} CI failed.`,
        availableActions: updated.availableActions,
        provider: ci.provider,
        overallStatus: ci.overallStatus,
        previousOverallStatus: previousCiStatus ?? "unknown",
        blocking: ci.blocking,
        ciSummary: ci.summary,
        affectedAgentId: updated.assigneeAgentId ?? null,
      });
      return { task: updated, outcome: "failed_transition" };
    } else if (crossedOutOfFailure(previousCiStatus, nextStatus)) {
      logNarrative({
        title: "CI Recovered",
        message: `${formatTaskLabel(updated)} is passing in ${formatCiProvider(ci.provider)} again`,
        operation: "task_ci_recovered",
        taskId: updated.id,
        provider: ci.provider,
      });
      await this.appendTaskEvent("task.ci_recovered", updated, {
        status: updated.status,
        previousStatus: previousTaskStatus,
        changedFields: ["ciStatus", "ci"],
        actor: { id: "system", role: "system" },
        summary: ci.headline ?? `${ci.provider} CI recovered.`,
        availableActions: updated.availableActions,
        provider: ci.provider,
        overallStatus: ci.overallStatus,
        previousOverallStatus: previousCiStatus ?? "unknown",
        blocking: ci.blocking,
        ciSummary: ci.summary,
        affectedAgentId: updated.assigneeAgentId ?? null,
      });
      return { task: updated, outcome: "recovered_transition" };
    }
    return { task: updated, outcome: "unchanged" };
  }

  private async appendTaskUpdatedEvent(
    task: TaskRecord,
    { previousStatus, summary }: { previousStatus: string; summary: string }
  ) {
    await this.appendTaskEvent("task.updated", task, {
      status: task.status,
      previousStatus,
      changedFields: ["submissions", "latestSubmissionId", "status", "availableActions", "source", "updatedAt"],
      actor: { id: task.assignee.id, role: "agent" },
      summary,
      availableActions: task.availableActions,
    });
  }

  private async appendTaskEvent(
    type: string,
    task: TaskRecord,
    data: Record<string, unknown>,
  ) {
    if (!this.eventStore) return;
    await this.eventStore.append({
      id: `evt_${crypto.randomBytes(10).toString("hex")}`,
      type,
      occurredAt: this.now().toISOString(),
      taskVersion: task.version,
      traceId: null,
      data: {
        ...data,
        taskId: task.id,
        taskIdentifier: task.identifier,
        links: {
          task: `${this.apiBaseUrl}/tasks/${task.id}`,
          reviewFeedback: `${this.apiBaseUrl}/tasks/${task.id}/review-feedback`,
          ciStatus: `${this.apiBaseUrl}/tasks/${task.id}/ci-status`,
          shipOperation: task.shipOperation
            ? `${this.apiBaseUrl}/ship-operations/${task.shipOperation.id}`
            : null,
        },
      },
    });
  }
}

function formatTaskLabel(task: TaskRecord): string {
  if (task.source?.provider === "linear" && task.source.linearIdentifier) {
    return `Task ${task.source.linearIdentifier}`;
  }
  if (task.source?.provider === "github" && task.source.owner && task.source.repo && task.source.issueNumber) {
    return `Task ${task.source.owner}/${task.source.repo}#${task.source.issueNumber}`;
  }
  return `Task ${task.identifier || task.id}`;
}

function formatCiProvider(provider: string): string {
  switch (provider) {
    case "github_actions":
      return "GitHub Actions";
    case "circleci":
      return "CircleCI";
    default:
      return provider;
  }
}

function crossedIntoFailure(previousStatus: string | null, nextStatus: string): boolean {
  return previousStatus !== "failed" && nextStatus === "failed";
}

function crossedOutOfFailure(previousStatus: string | null, nextStatus: string): boolean {
  return previousStatus === "failed" && nextStatus !== "failed";
}

function crossedFailureBoundary(previousStatus: string | null, nextStatus: string): boolean {
  return crossedIntoFailure(previousStatus, nextStatus) || crossedOutOfFailure(previousStatus, nextStatus);
}

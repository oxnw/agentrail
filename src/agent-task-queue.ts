import crypto from "node:crypto";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import { TaskStore, type TaskRecord } from "./task-store.ts";
import type { TaskEventStore } from "./task-event-store.ts";
import { getLatestTaskSubmission } from "./task-source-resolution.ts";
import { mergeTaskSource, validateTaskSourceRepairRequest, type TaskSourceRepairRequest } from "./task-source-repair.ts";

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
    prUrl: latestSubmission?.prUrl ?? task.source?.prUrl ?? null,
    prNumber: latestSubmission?.prNumber ?? task.source?.pullNumber ?? null,
    branch: latestSubmission?.branch ?? task.source?.branch ?? null,
    baseBranch: latestSubmission?.baseBranch ?? task.source?.baseBranch ?? null,
    headSha: latestSubmission?.headSha ?? task.source?.headSha ?? null,
    availableActions: task.availableActions,
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

  getIdempotencyEntry(key: string) {
    return this.store.getIdempotencyEntry(key);
  }

  setIdempotencyEntry(key: string, entry: Parameters<TaskStore["setIdempotencyEntry"]>[1]) {
    return this.store.setIdempotencyEntry(key, entry);
  }

  listRawTasks() {
    return this.store.listAllTasks();
  }

  private async appendTaskUpdatedEvent(
    task: TaskRecord,
    { previousStatus, summary }: { previousStatus: string; summary: string }
  ) {
    if (!this.eventStore) return;
    await this.eventStore.append({
      id: `evt_${crypto.randomBytes(10).toString("hex")}`,
      type: "task.updated",
      occurredAt: this.now().toISOString(),
      sequence: this.eventStore.getMaxSequence() + 1,
      taskVersion: task.version,
      traceId: null,
      data: {
        taskId: task.id,
        taskIdentifier: task.identifier,
        status: task.status,
        previousStatus,
        changedFields: ["status", "availableActions"],
        actor: { id: task.assignee.id, role: "agent" },
        summary,
        availableActions: task.availableActions,
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

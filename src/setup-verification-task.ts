import crypto from "node:crypto";

import type { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { TaskRecord } from "./task-store.ts";

export interface SetupVerificationTaskRequest {
  agentId: string;
  sourceRef?: string;
}

export interface SetupVerificationTaskData {
  taskId: string;
  taskIdentifier: string;
  agentId: string;
  sourceRef: string;
  status: TaskRecord["status"];
  availableActions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SetupVerificationTaskResponseBody {
  data: SetupVerificationTaskData;
  availableActions: string[];
}

interface IdempotencyEntry {
  fingerprint: string;
  response: unknown;
}

interface SetupVerificationTaskStore {
  createTask(partial: Omit<Partial<TaskRecord>, "id"> & { identifier: string; title: string }): TaskRecord;
  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id">>): TaskRecord | null;
  findTaskByIdentifier(identifier: string): TaskRecord | null;
  getIdempotencyEntry(key: string): IdempotencyEntry | null;
  setIdempotencyEntry(key: string, entry: IdempotencyEntry): void;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function asSetupTaskStore(taskLifecycleStore: unknown): SetupVerificationTaskStore {
  if (
    !taskLifecycleStore ||
    typeof taskLifecycleStore !== "object" ||
    typeof (taskLifecycleStore as SetupVerificationTaskStore).createTask !== "function" ||
    typeof (taskLifecycleStore as SetupVerificationTaskStore).updateTask !== "function" ||
    typeof (taskLifecycleStore as SetupVerificationTaskStore).findTaskByIdentifier !== "function" ||
    typeof (taskLifecycleStore as SetupVerificationTaskStore).getIdempotencyEntry !== "function" ||
    typeof (taskLifecycleStore as SetupVerificationTaskStore).setIdempotencyEntry !== "function"
  ) {
    throw new TaskLifecycleError(404, "not_found", "Setup verification task store is not configured.", {
      availableActions: ["contact_support"],
    });
  }

  return taskLifecycleStore as SetupVerificationTaskStore;
}

function normalizeAgentId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase();
}

function parseRepo(repoAllowlist: string[]): { repoKey: string | null; owner?: string; repo?: string } {
  const repoKey = repoAllowlist[0] ?? null;
  if (!repoKey) {
    return { repoKey: null };
  }

  const [owner, repo] = repoKey.split("/", 2);
  return { repoKey, owner, repo };
}

function buildIdentifier(agentId: string): string {
  return `LOCAL-SETUP-${normalizeAgentId(agentId)}`;
}

function buildResponse(task: TaskRecord, sourceRef: string): SetupVerificationTaskResponseBody {
  const agentId = task.assigneeAgentId ?? task.assignee.id;
  return {
    data: {
      taskId: task.id,
      taskIdentifier: task.identifier,
      agentId,
      sourceRef,
      status: task.status,
      availableActions: structuredClone(task.availableActions),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    availableActions: structuredClone(task.availableActions),
  };
}

export function createSetupVerificationTask({
  payload,
  routingControlPlane,
  taskLifecycleStore,
  idempotencyKey,
  now = () => new Date(),
}: {
  payload: SetupVerificationTaskRequest;
  routingControlPlane: RoutingControlPlane;
  taskLifecycleStore: unknown;
  idempotencyKey?: string;
  now?: () => Date;
}): SetupVerificationTaskResponseBody {
  if (!payload || typeof payload !== "object") {
    throw new TaskLifecycleError(400, "validation_error", "Setup verification task payload must be an object.", {
      availableActions: ["retry"],
    });
  }

  const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
  if (!agentId || !agentId.startsWith("agt_")) {
    throw new TaskLifecycleError(400, "validation_error", "Setup verification task `agentId` must start with `agt_`.", {
      availableActions: ["retry"],
    });
  }

  const sourceRef =
    typeof payload.sourceRef === "string" && payload.sourceRef.trim().length > 0
      ? payload.sourceRef.trim()
      : "operator_setup_verification";

  const store = asSetupTaskStore(taskLifecycleStore);
  const fingerprintPayload = { agentId, sourceRef };
  const fingerprint = sha256(fingerprintPayload);
  if (idempotencyKey) {
    const entry = store.getIdempotencyEntry(`setup-verification:${idempotencyKey}`);
    if (entry) {
      if (entry.fingerprint !== fingerprint) {
        throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different setup verification task payload.", {
          idempotencyKey,
          availableActions: ["retry"],
        });
      }
      return structuredClone(entry.response as SetupVerificationTaskResponseBody);
    }
  }

  const profile = routingControlPlane.getAgentProfile(agentId);
  if (!profile) {
    throw new TaskLifecycleError(404, "not_found", "Routing agent profile not found.", {
      availableActions: ["create_profile"],
    });
  }
  if (profile.status !== "active") {
    throw new TaskLifecycleError(409, "conflict", "Setup verification task requires an active routing agent profile.", {
      agentId,
      profileStatus: profile.status,
      availableActions: ["update_profile"],
    });
  }

  const identifier = buildIdentifier(agentId);
  const { repoKey, owner, repo } = parseRepo(profile.repoAllowlist);
  const timestamp = now().toISOString();
  const commonFields: Partial<Omit<TaskRecord, "id">> = {
    description: [
      `Setup verification smoke task for ${profile.displayName} (${agentId}).`,
      "",
      "Use the generated AgentRail API key and confirm `GET /tasks/mine?status=in_progress&limit=1` returns this task.",
      `Source ref: ${sourceRef}`,
    ].join("\n"),
    status: "in_progress",
    priority: "medium",
    assignee: {
      id: agentId,
      name: profile.displayName,
    },
    acceptanceCriteria: [
      `GET /tasks/mine?status=in_progress&limit=1 returns ${identifier}.`,
      `The task remains assigned to ${agentId}.`,
      "The setup runner can read the task without additional operator intervention.",
    ],
    links: {
      issue: `agentrail://setup-verification/${agentId}`,
    },
    context: {
      project: repoKey,
      goal: `Verify AgentRail setup for ${agentId}`,
    },
    availableActions: ["submit"],
    assigneeAgentId: agentId,
    triageQueueId: null,
    assignmentSource: null,
    routingDecisionId: null,
    routingReason: null,
    routingConfidence: null,
    source: {
      provider: "agentrail_setup",
      owner,
      repo,
      labels: ["setup", "verification"],
      deliveryId: sourceRef,
      receivedAt: timestamp,
    },
  };

  const existing = store.findTaskByIdentifier(identifier);
  const task = existing
    ? store.updateTask(existing.id, commonFields)
    : store.createTask({
        identifier,
        title: `Verify AgentRail setup for ${profile.displayName}`,
        createdAt: timestamp,
        submissions: [],
        latestSubmissionId: null,
        ciStatus: null,
        reviewOutcome: null,
        shipOperation: null,
        rollbackOperation: null,
        dueAt: null,
        version: 1,
        ...commonFields,
      });

  if (!task) {
    throw new TaskLifecycleError(500, "internal_error", "Failed to persist setup verification task.", {
      availableActions: ["retry"],
    });
  }

  const response = buildResponse(task, sourceRef);
  if (idempotencyKey) {
    store.setIdempotencyEntry(`setup-verification:${idempotencyKey}`, {
      fingerprint,
      response: structuredClone(response),
    });
  }

  return response;
}

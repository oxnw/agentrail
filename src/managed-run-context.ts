import type { AgentRunRecord } from "./agent-run-store.ts";

export interface ManagedRunContextRun {
  runId: string;
  agentId: string;
  runner: string;
  taskId: string;
  taskIdentifier: string;
  status: AgentRunRecord["status"];
  worktreePath: string;
  branchName: string | null;
}

export interface ManagedRunContextTask {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  acceptanceCriteria: string[];
  context?: Record<string, unknown> | null;
  availableActions: string[];
}

export interface ManagedRunContextAction {
  id: string;
  label: string;
}

export interface ManagedRunContextEnvelope {
  data: {
    run: ManagedRunContextRun;
    task: ManagedRunContextTask;
    nextActions: ManagedRunContextAction[];
  };
  availableActions: string[];
}

interface TaskEnvelope {
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nullableRecordValue(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? value : undefined;
}

export function describeManagedRunAction(action: string): ManagedRunContextAction {
  if (action === "submit") {
    return {
      id: "submit",
      label: "Finish the code change, commit locally, write the handoff file, then report completion.",
    };
  }
  if (action === "start") {
    return {
      id: "start",
      label: "AgentRail has already started this run; continue with the assigned task.",
    };
  }
  if (action === "resolve_blocker") {
    return {
      id: "resolve_blocker",
      label: "Report what is blocked and what user action is required.",
    };
  }
  return {
    id: action,
    label: `Follow AgentRail action: ${action}.`,
  };
}

export function buildManagedRunContextEnvelope({
  run,
  taskBody,
}: {
  run: AgentRunRecord;
  taskBody: TaskEnvelope | unknown;
}): ManagedRunContextEnvelope {
  const task = isRecord(taskBody) && isRecord((taskBody as TaskEnvelope).data)
    ? (taskBody as { data: Record<string, unknown> }).data
    : isRecord(taskBody) ? taskBody : {};
  const availableActions = stringArrayValue(task.availableActions);
  const taskId = stringValue(task.id) ?? run.taskId;
  const taskIdentifier = stringValue(task.identifier) ?? run.taskIdentifier;
  const taskTitle = stringValue(task.title) ?? run.taskIdentifier;
  return {
    data: {
      run: {
        runId: run.runId,
        agentId: run.agentId,
        runner: run.runner,
        taskId: run.taskId,
        taskIdentifier: run.taskIdentifier,
        status: run.status,
        worktreePath: run.worktreePath,
        branchName: run.branchName,
      },
      task: {
        id: taskId,
        identifier: taskIdentifier,
        title: taskTitle,
        ...(typeof task.description === "string" ? { description: task.description } : {}),
        status: stringValue(task.status) ?? "unknown",
        ...(typeof task.priority === "string" ? { priority: task.priority } : {}),
        acceptanceCriteria: stringArrayValue(task.acceptanceCriteria),
        ...(task.context !== undefined ? { context: nullableRecordValue(task.context) ?? null } : {}),
        availableActions,
      },
      nextActions: availableActions.map(describeManagedRunAction),
    },
    availableActions,
  };
}

export function isManagedRunContextEnvelope(value: unknown): value is ManagedRunContextEnvelope {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  const { run, task, nextActions } = value.data;
  if (!isRecord(run) || !isRecord(task) || !Array.isArray(nextActions)) return false;
  return typeof run.runId === "string"
    && typeof run.taskId === "string"
    && typeof task.id === "string"
    && typeof task.identifier === "string"
    && typeof task.title === "string"
    && Array.isArray(task.availableActions)
    && task.availableActions.every((entry) => typeof entry === "string")
    && Array.isArray(value.availableActions)
    && value.availableActions.every((entry) => typeof entry === "string");
}

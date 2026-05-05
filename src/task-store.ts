import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface TaskAssignee {
  id: string;
  name: string;
}

export interface TaskLinks {
  issue: string;
  parentIssue?: string | null;
}

export interface TaskContext {
  project: string | null;
  goal: string;
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskAssignmentSource = "deterministic_rule" | "classifier" | "manual_triage" | "provider_assignee_mapping";

export interface TaskSource {
  provider: string;
  owner?: string;
  repo?: string;
  issueNumber?: number;
  branch?: string;
  baseBranch?: string;
  headSha?: string;
  projectSlug?: string;
  ciProvider?: string;
  reviewers?: string[];
  pullNumber?: number;
  prUrl?: string;
  submissionId?: string;
  labels?: string[];
  assignees?: string[];
  deliveryId?: string;
  receivedAt?: string;
}

export interface TaskRecord {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: TaskAssignee;
  acceptanceCriteria: string[];
  links: TaskLinks;
  context: TaskContext;
  updatedAt: string;
  availableActions: string[];
  submissions: TaskSubmission[];
  latestSubmissionId: string | null;
  ciStatus: string | null;
  reviewOutcome: string | null;
  shipOperation: ShipOperation | null;
  rollbackOperation: RollbackOperation | null;
  dueAt: string | null;
  createdAt: string;
  version: number;
  source?: TaskSource;
  assigneeAgentId?: string | null;
  triageQueueId?: string | null;
  assignmentSource?: TaskAssignmentSource | null;
  routingDecisionId?: string | null;
  routingReason?: {
    summary: string;
    matchedRules: Array<{ id: string; name: string; confidence: number }>;
    classifier: {
      provider: string;
      confidence: number;
      suggestedTarget: { type: "agent" | "triage_queue"; id: string };
    } | null;
    conflictReasons: string[];
  } | null;
  routingConfidence?: number | null;
}

export interface IdempotencyEntry {
  fingerprint: string;
  response: unknown;
}

export interface TaskSubmission {
  id: string;
  summary: string;
  artifacts: string[];
  checks: unknown[];
  notes: string | null;
  submittedAt: string;
  prUrl?: string | null;
  prNumber?: number | null;
}

export interface ShipOperation {
  id: string;
  status: string;
  targetEnvironment: string;
  mode: string;
  queuedAt: string;
}

export interface RollbackOperation {
  revertedCommitSha: string;
  newHeadSha: string;
  rollbackPrUrl: string;
  rollbackPrNumber: number;
  reason: string | null;
  rolledBackAt: string;
}

export interface TaskStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

export interface ListTasksOptions {
  status?: string;
  assigneeAgentId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListTasksResult {
  data: TaskSummary[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
  availableActions: string[];
  meta: {
    tokenBudgetHint: string;
  };
}

export interface TaskSummary {
  id: string;
  identifier: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  updatedAt: string;
  availableActions: string[];
}

function createId(): string {
  return `tsk_${crypto.randomBytes(10).toString("hex")}`;
}

interface PersistedState {
  tasks?: TaskRecord[];
  idempotencyEntries?: Array<[string, IdempotencyEntry]>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPersistedState(value: unknown): value is PersistedState {
  return isObject(value) && Array.isArray(value.tasks);
}

function isLegacyTaskRecord(value: unknown): value is TaskRecord {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.identifier !== "string" || typeof value.title !== "string") return false;
  if (typeof value.status !== "string" || typeof value.priority !== "string") return false;
  if (typeof value.updatedAt !== "string" || typeof value.createdAt !== "string" || typeof value.version !== "number") return false;
  if (!Array.isArray(value.availableActions) || !Array.isArray(value.acceptanceCriteria) || !Array.isArray(value.submissions)) return false;
  if (!isObject(value.assignee) || typeof value.assignee.id !== "string" || typeof value.assignee.name !== "string") return false;
  if (!isObject(value.links) || typeof value.links.issue !== "string") return false;
  if (!isObject(value.context) || typeof value.context.goal !== "string") return false;
  return true;
}

function loadLegacyJsonlState(content: string): PersistedState | null {
  const tasks: TaskRecord[] = [];

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }

    if (!isLegacyTaskRecord(parsedLine)) {
      return null;
    }

    tasks.push(parsedLine);
  }

  return tasks.length > 0 ? { tasks, idempotencyEntries: [] } : null;
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  const content = readFileSync(storagePath, "utf8");
  if (!content.trim()) return {};

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isPersistedState(parsed)) {
      return parsed;
    }
    if (isLegacyTaskRecord(parsed)) {
      return {
        tasks: [parsed],
        idempotencyEntries: [],
      };
    }
    throw new Error(`Unsupported TaskStore state format in ${storagePath}`);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    const legacyState = loadLegacyJsonlState(content);
    if (legacyState) {
      return legacyState;
    }

    throw error;
  }
}

function loadTasks(state: PersistedState): Map<string, TaskRecord> {
  const map = new Map<string, TaskRecord>();
  if (!state.tasks) return map;
  for (const record of state.tasks) {
    map.set(record.id, record);
  }
  return map;
}

function persistState(storagePath: string | undefined, tasks: Map<string, TaskRecord>, idempotencyEntries: Map<string, IdempotencyEntry>): void {
  if (!storagePath) return;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const state: PersistedState = {
    tasks: [...tasks.values()],
    idempotencyEntries: [...idempotencyEntries.entries()],
  };
  writeFileSync(storagePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function toTaskSummary(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    updatedAt: task.updatedAt,
    availableActions: task.availableActions.filter((action) => ["start", "submit", "ship"].includes(action)),
  };
}

export class TaskStore {
  private _tasks: Map<string, TaskRecord>;
  private _idempotency: Map<string, IdempotencyEntry>;
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;

  constructor({ now = () => new Date(), storagePath }: TaskStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this._tasks = loadTasks(state);
    this._idempotency = new Map(state.idempotencyEntries ?? []);
  }

  listTasks({ status, assigneeAgentId, limit = 25, cursor = null }: ListTasksOptions = {}): ListTasksResult {
    const normalizedLimit = Math.min(100, Math.max(1, limit || 25));
    let tasks = [...this._tasks.values()];

    if (status) {
      tasks = tasks.filter((task) => task.status === status);
    }
    if (assigneeAgentId) {
      tasks = tasks.filter((task) => task.assignee.id === assigneeAgentId);
    }

    tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
    const page = tasks.slice(offset, offset + normalizedLimit);
    const nextOffset = offset + normalizedLimit;
    const hasMore = nextOffset < tasks.length;

    return {
      data: page.map(toTaskSummary),
      page: {
        nextCursor: hasMore ? Buffer.from(String(nextOffset)).toString("base64url") : null,
        hasMore,
      },
      availableActions: hasMore ? ["fetch_next_page"] : [],
      meta: {
        tokenBudgetHint: "compact",
      },
    };
  }

  getTask(taskId: string): TaskRecord | null {
    const task = this._tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  getIdempotencyEntry(key: string): IdempotencyEntry | null {
    return this._idempotency.get(key) ?? null;
  }

  setIdempotencyEntry(key: string, entry: IdempotencyEntry): void {
    this._idempotency.set(key, entry);
    this.persist();
  }

  findTaskByIdentifier(identifier: string): TaskRecord | null {
    for (const task of this._tasks.values()) {
      if (task.identifier === identifier) {
        return structuredClone(task);
      }
    }
    return null;
  }

  createTask(partial: Omit<Partial<TaskRecord>, "id"> & { identifier: string; title: string }): TaskRecord {
    const id = createId();
    const now = this.now().toISOString();
    const task: TaskRecord = {
      id,
      identifier: partial.identifier,
      title: partial.title,
      description: partial.description ?? "",
      status: partial.status ?? "todo",
      priority: partial.priority ?? "medium",
      assignee: partial.assignee ?? { id: "unknown", name: "Unknown" },
      acceptanceCriteria: partial.acceptanceCriteria ?? [],
      links: partial.links ?? { issue: "" },
      context: partial.context ?? { project: null, goal: "" },
      updatedAt: now,
      availableActions: partial.availableActions ?? ["start"],
      submissions: partial.submissions ?? [],
      latestSubmissionId: partial.latestSubmissionId ?? null,
      ciStatus: partial.ciStatus ?? null,
      reviewOutcome: partial.reviewOutcome ?? null,
      shipOperation: partial.shipOperation ?? null,
      rollbackOperation: partial.rollbackOperation ?? null,
      dueAt: partial.dueAt ?? null,
      createdAt: partial.createdAt ?? now,
      version: partial.version ?? 1,
      source: partial.source,
      assigneeAgentId: "assigneeAgentId" in partial ? (partial.assigneeAgentId ?? null) : (partial.assignee?.id ?? null),
      triageQueueId: "triageQueueId" in partial ? (partial.triageQueueId ?? null) : null,
      assignmentSource: "assignmentSource" in partial ? (partial.assignmentSource ?? null) : null,
      routingDecisionId: "routingDecisionId" in partial ? (partial.routingDecisionId ?? null) : null,
      routingReason: "routingReason" in partial ? (partial.routingReason ?? null) : null,
      routingConfidence: "routingConfidence" in partial ? (partial.routingConfidence ?? null) : null,
    };
    this._tasks.set(id, task);
    this.persist();
    return structuredClone(task);
  }

  upsertTask(record: TaskRecord): TaskRecord {
    this._tasks.set(record.id, record);
    this.persist();
    return structuredClone(record);
  }

  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id">>): TaskRecord | null {
    const existing = this._tasks.get(taskId);
    if (!existing) return null;
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this._tasks.set(taskId, updated);
    this.persist();
    return structuredClone(updated);
  }

  deleteTask(taskId: string): boolean {
    const existed = this._tasks.has(taskId);
    if (existed) {
      this._tasks.delete(taskId);
      this.persist();
    }
    return existed;
  }

  persist(): void {
    persistState(this.storagePath, this._tasks, this._idempotency);
  }
}

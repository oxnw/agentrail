import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getTaskSourceRepoKey,
  isLinearTaskSource,
  normalizeTaskSource,
  type RepoTaskSource,
  type TaskSource,
} from "./task-source.ts";

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
export type TaskAssignmentSource = "deterministic_rule" | "classifier" | "classifier_best_effort" | "manual_triage";
export type CiOverallStatus = "passed" | "failed" | "running" | "queued" | "cancelled" | "skipped" | "neutral" | "error";

export interface TaskProviderIssueSnapshot {
  provider: "github" | "linear" | "jira" | "gitlab";
  providerIssueId: string;
  sourceVersion: string;
  repository: {
    provider: "github" | "gitlab" | "linear";
    owner: string;
    name: string;
    defaultBranch: string;
  };
  title: string;
  bodyDigest: string;
  bodyPreview?: string;
  labels: string[];
  project?: string | null;
  issueType: "bug" | "feature" | "architecture" | "design" | "documentation" | "maintenance" | "unknown";
  priority: "low" | "medium" | "high" | "critical";
  ownershipTags: string[];
  capabilityTags: string[];
  links: {
    providerIssue: string;
  };
}

export interface TaskBlocker {
  kind: "awaiting_user";
  sourceRunId: string;
  sourceAgentId: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
  createdAt: string;
}

type TaskBlockerStringField = Exclude<{
  [K in keyof TaskBlocker]: TaskBlocker[K] extends string ? K : never;
}[keyof TaskBlocker], "kind">;

export interface TaskSourceAudit {
  sourceRef: string;
  changeReason: string;
  updatedBy: string;
  updatedAt: string;
}

export interface TaskCiState {
  provider: string;
  overallStatus: CiOverallStatus;
  blocking: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    running: number;
    queued: number;
    cancelled: number;
    skipped: number;
    neutral: number;
  };
  headline: string | null;
  updatedAt: string | null;
  lastTransitionAt: string | null;
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
  // Legacy flat mirror of `ci?.overallStatus`; keep synchronized for compatibility reads.
  ciStatus: CiOverallStatus | null;
  blocker: TaskBlocker | null;
  ci?: TaskCiState | null;
  reviewOutcome: string | null;
  shipOperation: ShipOperation | null;
  rollbackOperation: RollbackOperation | null;
  dueAt: string | null;
  createdAt: string;
  version: number;
  source?: TaskSource;
  sourceAudit?: TaskSourceAudit | null;
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
      taskType?: string;
      requiredCapabilities?: string[];
      optionalCapabilities?: string[];
      ownershipHints?: string[];
      missingInfo?: string[];
      unmatchedCapabilities?: string[];
      evidence?: string[];
    } | null;
    conflictReasons: string[];
  } | null;
  routingConfidence?: number | null;
  providerIssueSnapshot?: TaskProviderIssueSnapshot | null;
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
  branch?: string | null;
  baseBranch?: string | null;
  headSha?: string | null;
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
  blocker: TaskBlocker | null;
}

export type { LinearTaskSource, RepoTaskSource, TaskSource } from "./task-source.ts";

function createId(): string {
  return `tsk_${crypto.randomBytes(10).toString("hex")}`;
}

interface PersistedState {
  tasks?: TaskRecord[];
  idempotencyEntries?: Array<[string, IdempotencyEntry]>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedState(value: unknown): value is PersistedState {
  return isObject(value) && Array.isArray(value.tasks);
}

function isLegacyTaskRecord(value: unknown): value is TaskRecord {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.identifier !== "string" || typeof value.title !== "string") return false;
  if (typeof value.description !== "string") return false;
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
    map.set(record.id, normalizePersistedTaskRecord(record));
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

function normalizeTaskBlocker(value: unknown): TaskBlocker | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isObject(value) || value.kind !== "awaiting_user") {
    throw new Error("Task blocker must be an awaiting_user object.");
  }
  const sourceRunId = requiredTaskBlockerString(value, "sourceRunId");
  const sourceAgentId = requiredTaskBlockerString(value, "sourceAgentId");
  const reason = requiredTaskBlockerString(value, "reason");
  const actionRequired = requiredTaskBlockerString(value, "actionRequired");
  const resumeInstructions = requiredTaskBlockerString(value, "resumeInstructions");
  const createdAt = requiredTaskBlockerString(value, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error("Task blocker field `createdAt` must be a valid ISO date string.");
  }
  return {
    kind: "awaiting_user",
    sourceRunId,
    sourceAgentId,
    reason,
    actionRequired,
    resumeInstructions,
    createdAt,
  };
}

function requiredTaskBlockerString(value: Record<string, unknown>, field: TaskBlockerStringField): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Task blocker field \`${field}\` must be a non-empty string.`);
  }
  return fieldValue.trim();
}

function normalizePersistedTaskRecord(record: TaskRecord): TaskRecord {
  const normalized: TaskRecord = {
    ...record,
    blocker: normalizeTaskBlocker(record.blocker),
    source: normalizeTaskSource(record.source),
  };
  if ((record.assignmentSource as string | null | undefined) === "provider_assignee_mapping") {
    normalized.assignmentSource = "deterministic_rule";
  }
  return normalized;
}

function syncCiStatus(
  ciStatus: CiOverallStatus | null | undefined,
  ci: TaskCiState | null | undefined,
): CiOverallStatus | null {
  if (!ci) {
    return ciStatus ?? null;
  }
  if (ciStatus != null && ciStatus !== ci.overallStatus) {
    throw new Error(`ciStatus (${ciStatus}) must match ci.overallStatus (${ci.overallStatus}).`);
  }
  return ci.overallStatus;
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
    availableActions: task.availableActions.filter((action) => ["start", "submit", "ship", "resolve_blocker"].includes(action)),
    blocker: task.blocker ? structuredClone(task.blocker) : null,
  };
}

export class TaskStore {
  private _tasks: Map<string, TaskRecord>;
  private _idempotency: Map<string, IdempotencyEntry>;
  private _taskIdByIdentifier: Map<string, string>;
  private _taskIdsByLinearIssueId: Map<string, Set<string>>;
  private _taskIdsBySourceRepo: Map<string, Set<string>>;
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;

  constructor({ now = () => new Date(), storagePath }: TaskStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    const state = loadState(storagePath);
    this._tasks = loadTasks(state);
    this._idempotency = new Map(state.idempotencyEntries ?? []);
    this._taskIdByIdentifier = new Map();
    this._taskIdsByLinearIssueId = new Map();
    this._taskIdsBySourceRepo = new Map();
    for (const task of this._tasks.values()) {
      this.indexTask(task);
    }
  }

  listTasks({ status, assigneeAgentId, limit = 25, cursor = null }: ListTasksOptions = {}): ListTasksResult {
    const normalizedLimit = Math.min(100, Math.max(1, limit || 25));
    let tasks = [...this._tasks.values()];

    if (status) {
      tasks = tasks.filter((task) => task.status === status);
    }
    if (assigneeAgentId) {
      tasks = tasks.filter((task) => {
        const canonicalAssigneeAgentId = Object.prototype.hasOwnProperty.call(task, "assigneeAgentId")
          ? task.assigneeAgentId
          : task.assignee.id;
        return canonicalAssigneeAgentId === assigneeAgentId;
      });
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
    const taskId = this._taskIdByIdentifier.get(identifier);
    const task = taskId ? this._tasks.get(taskId) : null;
    return task ? structuredClone(task) : null;
  }

  findTaskByLinearIssueId(issueId: string): TaskRecord | null {
    const tasks = this.findTasksByLinearIssueId(issueId);
    return tasks[0] ?? null;
  }

  findTasksByLinearIssueId(issueId: string): TaskRecord[] {
    const taskIds = this._taskIdsByLinearIssueId.get(issueId);
    if (!taskIds) {
      return [];
    }
    return this.collectTasks(taskIds);
  }

  findTasksBySourceRepo(provider: RepoTaskSource["provider"], owner: string, repo: string): TaskRecord[] {
    const taskIds = this._taskIdsBySourceRepo.get(`${provider}:${owner}/${repo}`);
    if (!taskIds) {
      return [];
    }
    return this.collectTasks(taskIds);
  }

  listAllTasks(): TaskRecord[] {
    return [...this._tasks.values()].map((task) => structuredClone(task));
  }

  countTasks(predicate: (task: TaskRecord) => boolean, stopAt = Number.POSITIVE_INFINITY): number {
    if (stopAt <= 0) {
      return 0;
    }
    let count = 0;
    for (const task of this._tasks.values()) {
      if (!predicate(task)) {
        continue;
      }
      count += 1;
      if (count >= stopAt) {
        return count;
      }
    }
    return count;
  }

  createTask(partial: Omit<Partial<TaskRecord>, "id"> & { identifier: string; title: string }): TaskRecord {
    const id = createId();
    const now = this.now().toISOString();
    const ci = "ci" in partial ? (partial.ci ?? null) : null;
    const ciStatus = syncCiStatus(partial.ciStatus ?? null, ci);
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
      ciStatus,
      blocker: normalizeTaskBlocker(partial.blocker),
      ci,
      reviewOutcome: partial.reviewOutcome ?? null,
      shipOperation: partial.shipOperation ?? null,
      rollbackOperation: partial.rollbackOperation ?? null,
      dueAt: partial.dueAt ?? null,
      createdAt: partial.createdAt ?? now,
      version: partial.version ?? 1,
      source: normalizeTaskSource(partial.source),
      sourceAudit: "sourceAudit" in partial ? (partial.sourceAudit ?? null) : null,
      assigneeAgentId: "assigneeAgentId" in partial ? (partial.assigneeAgentId ?? null) : (partial.assignee?.id ?? null),
      triageQueueId: "triageQueueId" in partial ? (partial.triageQueueId ?? null) : null,
      assignmentSource: "assignmentSource" in partial ? (partial.assignmentSource ?? null) : null,
      routingDecisionId: "routingDecisionId" in partial ? (partial.routingDecisionId ?? null) : null,
      routingReason: "routingReason" in partial ? (partial.routingReason ?? null) : null,
      routingConfidence: "routingConfidence" in partial ? (partial.routingConfidence ?? null) : null,
      providerIssueSnapshot: "providerIssueSnapshot" in partial ? (partial.providerIssueSnapshot ?? null) : null,
    };
    this._tasks.set(id, task);
    this.indexTask(task);
    this.persist();
    return structuredClone(task);
  }

  upsertTask(record: TaskRecord): TaskRecord {
    const existing = this._tasks.get(record.id);
    const validatedRecord: TaskRecord = {
      ...record,
      ciStatus: syncCiStatus(record.ciStatus, record.ci),
      blocker: normalizeTaskBlocker(record.blocker),
      source: normalizeTaskSource(record.source),
    };
    if (existing) {
      this.unindexTask(existing);
    }
    this._tasks.set(validatedRecord.id, validatedRecord);
    this.indexTask(validatedRecord);
    this.persist();
    return structuredClone(validatedRecord);
  }

  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id">>): TaskRecord | null {
    const existing = this._tasks.get(taskId);
    if (!existing) return null;
    const ci = "ci" in patch ? (patch.ci ?? null) : existing.ci ?? null;
    const ciStatusInput = "ciStatus" in patch ? (patch.ciStatus ?? null) : existing.ciStatus;
    const source = "source" in patch ? normalizeTaskSource(patch.source) : existing.source;
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      ci,
      ciStatus: syncCiStatus(ciStatusInput, ci),
      blocker: "blocker" in patch ? normalizeTaskBlocker(patch.blocker) : existing.blocker ?? null,
      source,
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.unindexTask(existing);
    this._tasks.set(taskId, updated);
    this.indexTask(updated);
    this.persist();
    return structuredClone(updated);
  }

  deleteTask(taskId: string): boolean {
    const existing = this._tasks.get(taskId);
    if (existing) {
      this.unindexTask(existing);
      this._tasks.delete(taskId);
      this.persist();
      return true;
    }
    return false;
  }

  persist(): void {
    persistState(this.storagePath, this._tasks, this._idempotency);
  }

  private indexTask(task: TaskRecord): void {
    this._taskIdByIdentifier.set(task.identifier, task.id);
    const linearIssueId = isLinearTaskSource(task.source)
      ? task.source.linearIssueId
      : undefined;
    if (!linearIssueId) {
      const repoKey = getTaskSourceRepoKey(task.source);
      if (!repoKey) {
        return;
      }
      const repoTaskIds = this._taskIdsBySourceRepo.get(repoKey) ?? new Set<string>();
      repoTaskIds.add(task.id);
      this._taskIdsBySourceRepo.set(repoKey, repoTaskIds);
      return;
    }
    const taskIds = this._taskIdsByLinearIssueId.get(linearIssueId) ?? new Set<string>();
    taskIds.add(task.id);
    this._taskIdsByLinearIssueId.set(linearIssueId, taskIds);
    const repoKey = getTaskSourceRepoKey(task.source);
    if (!repoKey) {
      return;
    }
    const repoTaskIds = this._taskIdsBySourceRepo.get(repoKey) ?? new Set<string>();
    repoTaskIds.add(task.id);
    this._taskIdsBySourceRepo.set(repoKey, repoTaskIds);
  }

  private unindexTask(task: TaskRecord): void {
    if (this._taskIdByIdentifier.get(task.identifier) === task.id) {
      this._taskIdByIdentifier.delete(task.identifier);
    }
    const linearIssueId = isLinearTaskSource(task.source)
      ? task.source.linearIssueId
      : undefined;
    if (linearIssueId) {
      const taskIds = this._taskIdsByLinearIssueId.get(linearIssueId);
      if (taskIds) {
        taskIds.delete(task.id);
        if (taskIds.size === 0) {
          this._taskIdsByLinearIssueId.delete(linearIssueId);
        }
      }
    }

    const repoKey = getTaskSourceRepoKey(task.source);
    if (!repoKey) {
      return;
    }
    const repoTaskIds = this._taskIdsBySourceRepo.get(repoKey);
    if (!repoTaskIds) {
      return;
    }
    repoTaskIds.delete(task.id);
    if (repoTaskIds.size === 0) {
      this._taskIdsBySourceRepo.delete(repoKey);
    }
  }

  private collectTasks(taskIds: Iterable<string>): TaskRecord[] {
    return [...taskIds]
      .map((taskId) => this._tasks.get(taskId) ?? null)
      .filter((task): task is TaskRecord => task !== null)
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.id.localeCompare(right.id);
      })
      .map((task) => structuredClone(task));
  }
}

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export type AgentRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "awaiting_user"
  | "cancelled";

export type AgentRunReportStatus = "progress" | "blocked" | "completed";

export interface AgentRunUserAction {
  kind: "awaiting_user";
  taskId: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
  createdAt: string;
}

export interface AgentRunReport {
  status: AgentRunReportStatus;
  summary: string;
  createdAt: string;
  handoff: Record<string, unknown> | null;
}

export interface AgentRunRecord {
  runId: string;
  agentId: string;
  runner: string;
  taskId: string;
  taskIdentifier: string;
  status: AgentRunStatus;
  repoPath: string;
  worktreePath: string;
  branchName: string | null;
  promptPath: string | null;
  logPath: string | null;
  handoffPath: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  exitCode: number | null;
  summary: string | null;
  runContextTokenHash: string | null;
  runContextTokenIssuedAt: string | null;
  userAction: AgentRunUserAction | null;
  reports: AgentRunReport[];
  reportedHandoff: Record<string, unknown> | null;
  launch: {
    executable: string;
    args: string[];
  };
}

export type AgentRunInput =
  Omit<AgentRunRecord, "reports" | "reportedHandoff" | "runContextTokenHash" | "runContextTokenIssuedAt" | "userAction">
  & Partial<Pick<AgentRunRecord, "reports" | "reportedHandoff" | "runContextTokenHash" | "runContextTokenIssuedAt" | "userAction">>;

export type AgentRunReportInput =
  | {
    status: Exclude<AgentRunReportStatus, "blocked">;
    summary: string;
    handoff?: Record<string, unknown> | null;
  }
  | {
    status: "blocked";
    summary: string;
    reason: string;
    actionRequired: string;
    resumeInstructions: string;
    handoff?: Record<string, unknown> | null;
  };

interface PersistedState {
  runs?: AgentRunRecord[];
}

export interface AgentRunStoreOptions {
  now?: () => Date;
  storagePath?: string;
}

const RUN_STATUSES = new Set<AgentRunStatus>([
  "starting",
  "running",
  "succeeded",
  "failed",
  "awaiting_user",
  "cancelled",
]);

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  "starting",
  "running",
]);

const REPORT_STATUSES = new Set<AgentRunReportStatus>([
  "progress",
  "blocked",
  "completed",
]);

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_SLEEP_BUFFER = new SharedArrayBuffer(4);
const LOCK_SLEEP_ARRAY = new Int32Array(LOCK_SLEEP_BUFFER);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function warnInvalidState(storagePath: string | undefined, reason: string): void {
  if (!storagePath) return;
  process.emitWarning(`Ignoring invalid AgentRunStore state at ${storagePath}: ${reason}`);
}

export function createRunContextToken(): string {
  return `arrun_${randomBytes(24).toString("base64url")}`;
}

export function hashRunContextToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isRunContextToken(value: string): boolean {
  return /^arrun_[A-Za-z0-9_-]{24,}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

function normalizeRunReport(value: unknown): AgentRunReport | null {
  if (!isRecord(value)) return null;
  if (!REPORT_STATUSES.has(value.status as AgentRunReportStatus)) return null;
  if (!isString(value.summary) || !isString(value.createdAt)) return null;
  if (!isNullableRecord(value.handoff)) return null;
  return {
    status: value.status as AgentRunReportStatus,
    summary: value.summary,
    createdAt: value.createdAt,
    handoff: value.handoff ? structuredClone(value.handoff) : null,
  };
}

function normalizeRunUserAction(value: unknown): AgentRunUserAction | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (value.kind !== "awaiting_user" || !isString(value.taskId)) return null;
  if (!isString(value.reason) || !isString(value.actionRequired)) return null;
  if (!isString(value.resumeInstructions) || !isString(value.createdAt)) return null;
  return {
    kind: "awaiting_user",
    taskId: value.taskId,
    reason: value.reason,
    actionRequired: value.actionRequired,
    resumeInstructions: value.resumeInstructions,
    createdAt: value.createdAt,
  };
}

function normalizeRunRecord(value: unknown): AgentRunRecord | null {
  if (!isRecord(value)) return null;
  if (!isString(value.runId) || !isString(value.agentId) || !isString(value.runner)) return null;
  if (!isString(value.taskId) || !isString(value.taskIdentifier) || !isString(value.repoPath) || !isString(value.worktreePath)) return null;
  if (!isNullableString(value.branchName) || !isNullableString(value.promptPath) || !isNullableString(value.logPath) || !isNullableString(value.handoffPath)) return null;
  if (!isString(value.createdAt) || !isNullableString(value.startedAt) || !isNullableString(value.finishedAt) || !isString(value.updatedAt)) return null;
  if (!isNullableNumber(value.exitCode) || !isNullableString(value.summary)) return null;
  if (!RUN_STATUSES.has(value.status as AgentRunStatus)) return null;
  const userAction = value.userAction === undefined ? null : normalizeRunUserAction(value.userAction);
  if (value.userAction !== undefined && value.userAction !== null && userAction === null) return null;
  const reports = Array.isArray(value.reports)
    ? value.reports.map((entry) => normalizeRunReport(entry))
    : [];
  if (reports.some((entry) => entry === null)) return null;
  if (value.reportedHandoff !== undefined && !isNullableRecord(value.reportedHandoff)) return null;
  const runContextTokenHash = value.runContextTokenHash === undefined
    ? null
    : isNullableString(value.runContextTokenHash) ? value.runContextTokenHash : undefined;
  if (runContextTokenHash === undefined) return null;
  const runContextTokenIssuedAt = value.runContextTokenIssuedAt === undefined
    ? null
    : isNullableString(value.runContextTokenIssuedAt) ? value.runContextTokenIssuedAt : undefined;
  if (runContextTokenIssuedAt === undefined) return null;
  if (
    !isRecord(value.launch)
    || !isString(value.launch.executable)
    || !Array.isArray(value.launch.args)
    || !value.launch.args.every(isString)
  ) {
    return null;
  }
  return {
    runId: value.runId,
    agentId: value.agentId,
    runner: value.runner,
    taskId: value.taskId,
    taskIdentifier: value.taskIdentifier,
    status: value.status as AgentRunStatus,
    repoPath: value.repoPath,
    worktreePath: value.worktreePath,
    branchName: value.branchName,
    promptPath: value.promptPath,
    logPath: value.logPath,
    handoffPath: value.handoffPath,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    updatedAt: value.updatedAt,
    exitCode: value.exitCode,
    summary: value.summary,
    runContextTokenHash,
    runContextTokenIssuedAt,
    userAction,
    reports: reports as AgentRunReport[],
    reportedHandoff: value.reportedHandoff === undefined || value.reportedHandoff === null
      ? null
      : structuredClone(value.reportedHandoff as Record<string, unknown>),
    launch: {
      executable: value.launch.executable,
      args: [...value.launch.args],
    },
  };
}

function loadState(storagePath: string | undefined): PersistedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  try {
    const content = readFileSync(storagePath, "utf8");
    if (!content.trim()) return {};
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && (parsed.runs === undefined || Array.isArray(parsed.runs))) {
      return parsed as PersistedState;
    }
    warnInvalidState(storagePath, "state object shape is unsupported");
    return {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      warnInvalidState(storagePath, error.message);
      return {};
    }
    throw error;
  }
}

function persistState(storagePath: string | undefined, runs: Map<string, AgentRunRecord>): void {
  if (!storagePath) return;
  const directory = path.dirname(storagePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(storagePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify({ runs: [...runs.values()] }, null, 2) + "\n", "utf8");
    renameSync(tempPath, storagePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
        process.emitWarning(`Failed to remove temporary AgentRunStore file ${tempPath}: ${String(cleanupError)}`);
      }
    }
    throw error;
  }
}

function getStorageMtimeMs(storagePath: string): number | null {
  try {
    return statSync(storagePath).mtimeMs;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function acquireStorageLock(storagePath: string | undefined): (() => void) | null {
  if (!storagePath) return null;
  const lockPath = `${storagePath}.lock`;
  mkdirSync(path.dirname(storagePath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf8");
      } catch (writeError) {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch (cleanupError) {
          if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
            process.emitWarning(`Failed to remove incomplete AgentRunStore lock at ${lockPath}: ${String(cleanupError)}`);
          }
        }
        throw writeError;
      }
      return () => {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (!isNodeErrorWithCode(error, "ENOENT")) {
            process.emitWarning(`Failed to remove AgentRunStore lock at ${lockPath}: ${String(error)}`);
          }
        }
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
      if (removeStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for AgentRunStore lock at ${lockPath}.`);
      }
      Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, 25);
    }
  }
}

function removeStaleLock(lockPath: string): boolean {
  try {
    const initialContent = readFileSync(lockPath, "utf8");
    const [, timestampText] = initialContent.trim().split(/\s+/u);
    const lockTimestamp = Number.parseInt(timestampText ?? "", 10);
    const mtimeMs = statSync(lockPath).mtimeMs;
    const ageMs = Date.now() - (Number.isFinite(lockTimestamp) ? lockTimestamp : mtimeMs);
    if (ageMs > STALE_LOCK_MS) {
      if (readFileSync(lockPath, "utf8") !== initialContent) {
        return false;
      }
      unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    return true;
  }
}

export class AgentRunStore {
  private readonly now: () => Date;
  private readonly storagePath: string | undefined;
  private readonly runs: Map<string, AgentRunRecord>;
  private lastMtimeMs: number | null;

  constructor({ now = () => new Date(), storagePath }: AgentRunStoreOptions = {}) {
    this.now = now;
    this.storagePath = storagePath;
    this.runs = new Map();
    this.lastMtimeMs = null;
    this.reload();
  }

  getRun(runId: string): AgentRunRecord | null {
    this.reload();
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  listRuns({
    agentId,
    status,
    limit,
  }: {
    agentId?: string;
    status?: AgentRunStatus;
    limit?: number;
  } = {}): AgentRunRecord[] {
    this.reload();
    let runs = [...this.runs.values()];
    if (agentId) {
      runs = runs.filter((run) => run.agentId === agentId);
    }
    if (status) {
      runs = runs.filter((run) => run.status === status);
    }
    runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (limit !== undefined && !Number.isInteger(limit)) {
      throw new TypeError("Agent run list limit must be an integer.");
    }
    if (typeof limit === "number" && limit < 0) {
      throw new RangeError("Agent run list limit must be non-negative.");
    }
    const normalizedLimit = Number.isInteger(limit) && limit >= 0 ? limit : runs.length;
    return runs.slice(0, normalizedLimit).map(clone);
  }

  countActiveRuns(agentId: string): number {
    this.reload();
    return [...this.runs.values()].filter((run) => run.agentId === agentId && ACTIVE_RUN_STATUSES.has(run.status)).length;
  }

  findActiveRunByTask(agentId: string, taskId: string): AgentRunRecord | null {
    this.reload();
    const run = [...this.runs.values()].find((entry) =>
      entry.agentId === agentId && entry.taskId === taskId && ACTIVE_RUN_STATUSES.has(entry.status));
    return run ? clone(run) : null;
  }

  verifyRunContextToken(runId: string, token: string): AgentRunRecord | null {
    if (!isRunContextToken(token)) return null;
    this.reload();
    const run = this.runs.get(runId);
    if (!run?.runContextTokenHash) return null;
    const actual = Buffer.from(hashRunContextToken(token), "hex");
    const expected = Buffer.from(run.runContextTokenHash, "hex");
    if (actual.length === 0 || actual.length !== expected.length) return null;
    return timingSafeEqual(actual, expected) ? clone(run) : null;
  }

  createRun(run: AgentRunInput): AgentRunRecord {
    return this.withStorageLock(() => {
      if (this.runs.has(run.runId)) {
        throw new Error(`Agent run ${run.runId} already exists.`);
      }
      const normalized = normalizeRunRecord({
        ...run,
        userAction: run.userAction ?? null,
      });
      if (!normalized) {
        throw new Error("Invalid agent run record.");
      }
      this.runs.set(normalized.runId, normalized);
      this.persist();
      return clone(normalized);
    });
  }

  updateRun(runId: string, patch: Partial<Omit<AgentRunRecord, "runId" | "agentId" | "taskId" | "createdAt">>): AgentRunRecord | null {
    return this.withStorageLock(() => {
      const existing = this.runs.get(runId);
      if (!existing) return null;
      const updated = normalizeRunRecord({
        ...existing,
        ...patch,
        runId: existing.runId,
        agentId: existing.agentId,
        taskId: existing.taskId,
        createdAt: existing.createdAt,
        updatedAt: patch.updatedAt ?? this.now().toISOString(),
      });
      if (!updated) {
        throw new Error(`Invalid agent run update for ${runId}.`);
      }
      this.runs.set(runId, updated);
      this.persist();
      return clone(updated);
    });
  }

  reportRun(runId: string, report: AgentRunReportInput): AgentRunRecord | null {
    return this.withStorageLock(() => {
      const existing = this.runs.get(runId);
      if (!existing) return null;
      if (!REPORT_STATUSES.has(report.status)) {
        throw new Error(`Unsupported agent run report status: ${report.status}.`);
      }
      if (typeof report.summary !== "string" || report.summary.trim().length === 0) {
        throw new Error("Agent run report summary must be a non-empty string.");
      }
      const trimmedSummary = report.summary.trim();
      const timestamp = this.now().toISOString();
      let userAction = existing.userAction;
      if (report.status === "blocked") {
        if (typeof report.reason !== "string" || report.reason.trim().length === 0) {
          throw new Error("Agent run blocked report reason must be a non-empty string.");
        }
        if (typeof report.actionRequired !== "string" || report.actionRequired.trim().length === 0) {
          throw new Error("Agent run blocked report actionRequired must be a non-empty string.");
        }
        if (typeof report.resumeInstructions !== "string" || report.resumeInstructions.trim().length === 0) {
          throw new Error("Agent run blocked report resumeInstructions must be a non-empty string.");
        }
        userAction = {
          kind: "awaiting_user",
          taskId: existing.taskId,
          reason: report.reason.trim(),
          actionRequired: report.actionRequired.trim(),
          resumeInstructions: report.resumeInstructions.trim(),
          createdAt: timestamp,
        };
      }
      const handoffWasProvided = report.handoff !== undefined;
      const handoff = report.handoff === undefined ? null : report.handoff;
      const updated = normalizeRunRecord({
        ...existing,
        status: report.status === "blocked" ? "awaiting_user" : existing.status,
        summary: trimmedSummary,
        userAction,
        reports: [
          ...existing.reports,
          {
            status: report.status,
            summary: trimmedSummary,
            createdAt: timestamp,
            handoff,
          },
        ],
        reportedHandoff: handoffWasProvided ? handoff : existing.reportedHandoff,
        updatedAt: timestamp,
      });
      if (!updated) {
        throw new Error(`Invalid agent run report for ${runId}.`);
      }
      this.runs.set(runId, updated);
      this.persist();
      return clone(updated);
    });
  }

  private persist(): void {
    persistState(this.storagePath, this.runs);
    this.lastMtimeMs = this.storagePath ? getStorageMtimeMs(this.storagePath) : null;
  }

  private reload(): void {
    if (!this.storagePath) return;
    const mtimeMs = getStorageMtimeMs(this.storagePath);
    if (mtimeMs === this.lastMtimeMs) {
      return;
    }
    if (mtimeMs === null) {
      this.runs.clear();
      this.lastMtimeMs = null;
      return;
    }
    const state = loadState(this.storagePath);
    this.runs.clear();
    for (const [index, entry] of (state.runs ?? []).entries()) {
      const normalized = normalizeRunRecord(entry);
      if (normalized) {
        this.runs.set(normalized.runId, normalized);
      } else {
        const runId = isRecord(entry) && isString(entry.runId) ? entry.runId : `index ${index}`;
        warnInvalidState(this.storagePath, `run record ${runId} is invalid`);
      }
    }
    this.lastMtimeMs = mtimeMs;
  }

  private withStorageLock<T>(operation: () => T): T {
    const release = acquireStorageLock(this.storagePath);
    try {
      this.reload();
      return operation();
    } finally {
      release?.();
    }
  }
}

/** GitHub issue intake adapter: maps a GitHub issue to the AgentRail task store. */
import crypto from "node:crypto";

import type { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { AgentTaskQueue } from "./agent-task-queue.ts";
import type { TaskStatus } from "./task-store.ts";

export interface GitHubIssueIntakePayload {
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  body?: string | null;
  labels?: string[];
  state?: string;
  repository?: { owner: string; repo: string } | null;
  assignees?: Array<{ login: string }>;
}

export interface GitHubIssueIntakeResult {
  taskId: string;
  identifier: string;
  status: string;
  availableActions: string[];
  createdAt: string;
  outcome?: "created" | "updated" | "unchanged";
  routing?: {
    kind: "assigned" | "triage" | "stored_without_routing";
    target: string | null;
  };
}

export interface GitHubIssueIntakeAdapterConfig {
  taskQueue: AgentTaskQueue;
  routingControlPlane?: RoutingControlPlane | null;
  routingMode?: "optional" | "required";
  repos?: Array<{ slug: string; defaultBranch: string; circleciProjectSlug?: string }>;
  now?: () => Date;
}

interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

function hasField<Key extends PropertyKey>(value: object, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Map) {
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const entries = [...value.entries()]
      .map(([key, entryValue]) => [stableStringify(key, seen), stableStringify(entryValue, seen)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    seen.delete(value);
    return `{"$map":[${entries.map(([key, entryValue]) => `[${key},${entryValue}]`).join(",")}]}`;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const entries = [...value.values()].map(entry => stableStringify(entry, seen)).sort();
    seen.delete(value);
    return `{"$set":[${entries.join(",")}]}`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const serialized = `[${value.map(item => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const serialized = `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

const GITHUB_ISSUE_INTAKE_OUTCOMES = new Set(["created", "updated", "unchanged"]);
const GITHUB_ISSUE_INTAKE_ROUTING_KINDS = new Set(["assigned", "triage", "stored_without_routing"]);
const MAX_ROUTING_BODY_PREVIEW_CHARS = 6000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubIssueIntakeResult(value: unknown): value is GitHubIssueIntakeResult {
  if (!isRecord(value)) return false;
  if (typeof value.taskId !== "string" || typeof value.identifier !== "string") return false;
  if (typeof value.status !== "string" || typeof value.createdAt !== "string") return false;
  if (!Array.isArray(value.availableActions) || !value.availableActions.every((action) => typeof action === "string")) {
    return false;
  }
  if (value.outcome !== undefined && (typeof value.outcome !== "string" || !GITHUB_ISSUE_INTAKE_OUTCOMES.has(value.outcome))) {
    return false;
  }
  if (value.routing !== undefined) {
    if (!isRecord(value.routing)) return false;
    if (typeof value.routing.kind !== "string" || !GITHUB_ISSUE_INTAKE_ROUTING_KINDS.has(value.routing.kind)) return false;
    if (value.routing.target !== null && typeof value.routing.target !== "string") return false;
  }
  return true;
}

export class GitHubIssueIntakeAdapter {
  private taskQueue: AgentTaskQueue;
  private routingControlPlane: RoutingControlPlane | null;
  private routingMode: "optional" | "required";
  private repos: Array<{ slug: string; defaultBranch: string; circleciProjectSlug?: string }>;
  private now: () => Date;

  constructor({ taskQueue, routingControlPlane = null, routingMode = "optional", repos = [], now = () => new Date() }: GitHubIssueIntakeAdapterConfig) {
    this.taskQueue = taskQueue;
    this.routingControlPlane = routingControlPlane;
    this.routingMode = routingMode;
    this.repos = repos;
    this.now = now;
  }

  async ingest(payload: GitHubIssueIntakePayload, idempotencyKey?: string): Promise<GitHubIssueIntakeResult> {
    if (!payload.issueNumber || typeof payload.issueNumber !== "number") {
      throw new TaskLifecycleError(400, "validation_error", "`issueNumber` is required and must be a number.", {
        availableActions: ["retry"],
      });
    }

    const repository = this.resolveRepository(payload);
    const repoConfig = this.findRepoConfig(repository);
    const identifier = this.buildIdentifier(repository, payload.issueNumber);
    const fingerprint = sha256(payload);
    const idempotencyStoreKey = idempotencyKey ? `github-issue-intake:${idempotencyKey}` : null;

    if (idempotencyStoreKey) {
      const cached = this.taskQueue.getIdempotencyEntry(idempotencyStoreKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different GitHub issue intake payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        const replay = structuredClone(cached.response);
        if (!isGitHubIssueIntakeResult(replay)) {
          throw new TaskLifecycleError(500, "internal_error", "Cached GitHub issue intake response has invalid shape.", {
            availableActions: ["retry"],
          });
        }
        if (replay.outcome === "created" || replay.outcome === "updated") {
          replay.outcome = "unchanged";
        }
        return replay;
      }
    }

    const existing = this.taskQueue.findTaskByIdentifier(identifier);

    if (existing) {
      const hasBody = hasField(payload, "body");
      const hasLabels = hasField(payload, "labels");
      const hasState = hasField(payload, "state");
      const description = hasBody ? (payload.body ?? "") : existing.description;
      const acceptanceCriteria = hasBody ? this.extractAcceptanceCriteria(payload.body ?? "") : existing.acceptanceCriteria;
      const labels = hasLabels ? (payload.labels ?? []) : (existing.source?.labels ?? []);
      const status = hasState ? mapIssueStateOntoExistingTask(existing.status, payload.state) : existing.status;

      const nextTaskState = {
        title: payload.issueTitle ?? existing.title,
        description,
        status,
        priority: hasLabels ? this.mapPriority(payload.labels ?? []) : existing.priority,
        acceptanceCriteria,
        links: { issue: payload.issueUrl },
        context: {
          project: `${repository.owner}/${repository.repo}`,
          goal: `GitHub issue intake: #${payload.issueNumber}`,
        },
        source: {
          provider: "github",
          owner: repository.owner,
          repo: repository.repo,
          issueNumber: payload.issueNumber,
          ...this.buildCiSourceMetadata(repoConfig),
          labels,
          assignees: payload.assignees?.map((assignee) => assignee.login) ?? existing.source?.assignees ?? [],
        },
      };
      if (githubTaskStateMatches(existing, nextTaskState)) {
        const result = this.resultFor(existing, "unchanged", describeRouting(existing, false));
        if (idempotencyStoreKey) {
          this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
        }
        return result;
      }

      const updated = this.taskQueue.updateTask(existing.id, {
        title: payload.issueTitle ?? existing.title,
        description,
        status,
        priority: hasLabels ? this.mapPriority(payload.labels ?? []) : existing.priority,
        acceptanceCriteria,
        links: { issue: payload.issueUrl },
        context: {
          project: `${repository.owner}/${repository.repo}`,
          goal: `GitHub issue intake: #${payload.issueNumber}`,
        },
        source: {
          provider: "github",
          owner: repository.owner,
          repo: repository.repo,
          issueNumber: payload.issueNumber,
          ...this.buildCiSourceMetadata(repoConfig),
          labels,
          assignees: payload.assignees?.map((assignee) => assignee.login) ?? existing.source?.assignees ?? [],
          deliveryId: idempotencyKey ?? existing.source?.deliveryId,
          receivedAt: this.now().toISOString(),
        },
      });

      if (!updated) {
        throw new TaskLifecycleError(500, "internal_error", "Failed to update existing task.", { availableActions: ["retry"] });
      }

      const result = this.resultFor(updated, "updated", describeRouting(updated, false));

      if (idempotencyStoreKey) {
        this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
      }

      return result;
    }

    const routedTaskId = await this.routeIssueIfConfigured({
      identifier,
      repository,
      payload,
      idempotencyKey,
    });
    const baseTask = routedTaskId
      ? this.taskQueue.getRawTask(routedTaskId)
      : this.taskQueue.createTask({
          identifier,
          title: payload.issueTitle ?? `Issue #${payload.issueNumber}`,
          description: payload.body ?? "",
          status: this.mapStatus(payload.state),
          priority: this.mapPriority(payload.labels ?? []),
          assignee: { id: "unassigned", name: "Unassigned" },
          assigneeAgentId: null,
          links: {
            issue: payload.issueUrl,
          },
          context: {
            project: `${repository.owner}/${repository.repo}`,
            goal: `GitHub issue intake: #${payload.issueNumber}`,
          },
          acceptanceCriteria: this.extractAcceptanceCriteria(payload.body ?? ""),
          createdAt: this.now().toISOString(),
          availableActions: ["start"],
          submissions: [],
          latestSubmissionId: null,
          ciStatus: null,
          reviewOutcome: null,
          shipOperation: null,
          rollbackOperation: null,
          dueAt: null,
          version: 1,
          source: {
            provider: "github",
            owner: repository.owner,
            repo: repository.repo,
            issueNumber: payload.issueNumber,
            ...this.buildCiSourceMetadata(repoConfig),
            labels: payload.labels ?? [],
            assignees: payload.assignees?.map((assignee) => assignee.login) ?? [],
            deliveryId: idempotencyKey,
            receivedAt: this.now().toISOString(),
          },
        });
    if (!baseTask) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to create routed GitHub task.", { availableActions: ["retry"] });
    }
    const taskRecord = this.taskQueue.updateTask(baseTask.id, {
      identifier,
      title: payload.issueTitle ?? `Issue #${payload.issueNumber}`,
      description: payload.body ?? "",
      status: this.mapStatus(payload.state),
      priority: this.mapPriority(payload.labels ?? []),
      links: {
        issue: payload.issueUrl,
      },
      context: {
        project: `${repository.owner}/${repository.repo}`,
        goal: `GitHub issue intake: #${payload.issueNumber}`,
      },
      acceptanceCriteria: this.extractAcceptanceCriteria(payload.body ?? ""),
      availableActions: baseTask.assigneeAgentId ? ["start"] : baseTask.availableActions,
      source: {
        provider: "github",
        owner: repository.owner,
        repo: repository.repo,
        issueNumber: payload.issueNumber,
        ...this.buildCiSourceMetadata(repoConfig),
        labels: payload.labels ?? [],
        assignees: payload.assignees?.map((assignee) => assignee.login) ?? [],
        deliveryId: idempotencyKey,
        receivedAt: this.now().toISOString(),
      },
    }) ?? baseTask;

    const result = this.resultFor(taskRecord, "created", describeRouting(taskRecord, !routedTaskId));

    if (idempotencyStoreKey) {
      this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
    }

    return result;
  }

  /** Build a deterministic identifier from the issue URL, e.g. "github:oxnw/agentrail:issues/10". */
  private buildIdentifier(repository: GitHubRepositoryRef, issueNumber: number): string {
    return `github:${repository.owner}/${repository.repo}:issues/${issueNumber}`;
  }

  private findRepoConfig(repository: GitHubRepositoryRef): { slug: string; defaultBranch: string; circleciProjectSlug?: string } | null {
    const repoSlug = `${repository.owner}/${repository.repo}`;
    return this.repos.find((candidate) => candidate.slug === repoSlug) ?? null;
  }

  private buildCiSourceMetadata(repoConfig: { circleciProjectSlug?: string } | null): {
    ciProvider?: "circleci";
    projectSlug?: string;
  } {
    const projectSlug = repoConfig?.circleciProjectSlug?.trim();
    if (!projectSlug) {
      return {};
    }
    return {
      ciProvider: "circleci",
      projectSlug,
    };
  }

  private resolveRepository(payload: GitHubIssueIntakePayload): GitHubRepositoryRef {
    if (payload.repository?.owner && payload.repository.repo) {
      return payload.repository;
    }

    try {
      const url = new URL(payload.issueUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      const [owner, repo] = parts[0] === "repos"
        ? [parts[1], parts[2]]
        : [parts[0], parts[1]];
      if (owner && repo) {
        return { owner, repo };
      }
    } catch {
      // fall through
    }

    throw new TaskLifecycleError(
      400,
      "validation_error",
      "`repository` is required when `issueUrl` cannot be parsed into owner/repo context.",
      { availableActions: ["retry"] },
    );
  }

  private async routeIssueIfConfigured({
    identifier,
    repository,
    payload,
    idempotencyKey,
  }: {
    identifier: string;
    repository: GitHubRepositoryRef;
    payload: GitHubIssueIntakePayload;
    idempotencyKey?: string;
  }): Promise<string | null> {
    if (!this.routingControlPlane) {
      if (this.routingMode === "required") {
        throw new TaskLifecycleError(503, "misconfigured", "Provider issue routing is required but the routing control plane is not configured.", {
          availableActions: ["configure_routing"],
        });
      }
      return null;
    }
    const repoSlug = `${repository.owner}/${repository.repo}`;
    const repo = this.findRepoConfig(repository);
    try {
      const decision = await this.routingControlPlane.ingestProviderIssue({
        provider: "github",
        providerIssueId: identifier,
        sourceVersion: idempotencyKey ?? `${this.now().toISOString()}:github`,
        repository: {
          provider: "github",
          owner: repository.owner,
          name: repository.repo,
          defaultBranch: repo?.defaultBranch ?? "main",
        },
        title: payload.issueTitle ?? `Issue #${payload.issueNumber}`,
        bodyDigest: sha256(payload.body ?? ""),
        bodyPreview: bodyPreviewForRouting(payload.body),
        labels: payload.labels ?? [],
        project: repoSlug,
        issueType: classifyIssueType(payload.labels ?? [], payload.issueTitle ?? "", payload.body ?? ""),
        priority: this.mapPriority(payload.labels ?? []),
        ownershipTags: [],
        capabilityTags: [],
        links: {
          providerIssue: payload.issueUrl,
        },
      }, idempotencyKey ? `github-route:${idempotencyKey}` : undefined);
      return decision.taskId;
    } catch (error) {
      if (this.routingMode === "optional" && error instanceof TaskLifecycleError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private mapStatus(state?: string | null): "todo" | "in_progress" | "blocked" | "done" | "cancelled" {
    switch (state) {
      case "open": return "todo";
      case "in_progress": return "in_progress";
      case "closed": return "done";
      default: return "todo";
    }
  }

  private mapPriority(labels: string[]): "low" | "medium" | "high" | "critical" {
    const lowered = labels.map(l => l.toLowerCase());
    if (lowered.some(l => l.includes("critical") || l.includes("p0") || l.includes("urgent"))) return "critical";
    if (lowered.some(l => l.includes("high") || l.includes("p1"))) return "high";
    if (lowered.some(l => l.includes("low") || l.includes("p2"))) return "low";
    return "medium";
  }

  private extractAcceptanceCriteria(body: string): string[] {
    const lines = body.split("\n");
    const criteria: string[] = [];
    let inList = false;
    for (const line of lines) {
      if (/^(#+\s*)?acceptance criteria/i.test(line)) {
        inList = true;
        continue;
      }
      if (inList) {
        if (/^\s*[-*+]\s+/.test(line)) {
          const item = line.replace(/^\s*[-*+]\s+/, "").trim();
          if (item) criteria.push(item.replace(/^\[[ x]\]\s*/i, ""));
        } else if (/^\s*\d+\.\s+/.test(line)) {
          const item = line.replace(/^\s*\d+\.\s+/, "").trim();
          if (item) criteria.push(item.replace(/^\[[ x]\]\s*/i, ""));
        } else if (line.trim() === "" || /^(#+\s*)/.test(line)) {
          break;
        } else {
          break;
        }
      }
    }
    return criteria;
  }

  private resultFor(
    task: NonNullable<ReturnType<AgentTaskQueue["getRawTask"]>>,
    outcome: "created" | "updated" | "unchanged",
    routing: GitHubIssueIntakeResult["routing"],
  ): GitHubIssueIntakeResult {
    return {
      taskId: task.id,
      identifier: task.identifier,
      status: task.status,
      availableActions: task.availableActions,
      createdAt: task.createdAt,
      outcome,
      routing,
    };
  }
}

function bodyPreviewForRouting(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\r\n?/gu, "\n").trim();
  return normalized.length > MAX_ROUTING_BODY_PREVIEW_CHARS
    ? `${normalized.slice(0, MAX_ROUTING_BODY_PREVIEW_CHARS)}\n[truncated]`
    : normalized;
}

function mapIssueStateOntoExistingTask(currentStatus: TaskStatus, issueState?: string | null): TaskStatus {
  if (issueState === "closed") {
    return "done";
  }
  if (issueState === "open") {
    return currentStatus === "in_progress" || currentStatus === "in_review" || currentStatus === "blocked"
      ? currentStatus
      : "todo";
  }
  if (issueState === "in_progress") {
    return "in_progress";
  }
  return currentStatus;
}

function githubTaskStateMatches(existing: ReturnType<AgentTaskQueue["getRawTask"]>, next: {
  title: string;
  description: string;
  status: string;
  priority: string;
  acceptanceCriteria: string[];
  links: { issue: string };
  context: { project: string; goal: string };
  source: {
    provider: string;
    owner: string;
    repo: string;
    issueNumber: number;
    labels: string[];
    assignees: string[];
  };
}): boolean {
  return stableStringify({
    title: existing?.title,
    description: existing?.description,
    status: existing?.status,
    priority: existing?.priority,
    acceptanceCriteria: existing?.acceptanceCriteria ?? [],
    links: { issue: existing?.links?.issue ?? "" },
    context: existing?.context,
    source: {
      provider: existing?.source?.provider ?? null,
      owner: existing?.source?.owner ?? null,
      repo: existing?.source?.repo ?? null,
      issueNumber: existing?.source?.issueNumber ?? null,
      labels: existing?.source?.labels ?? [],
      assignees: existing?.source?.assignees ?? [],
    },
  }) === stableStringify(next);
}

function describeRouting(
  task: NonNullable<ReturnType<AgentTaskQueue["getRawTask"]>>,
  storedWithoutRouting: boolean,
): GitHubIssueIntakeResult["routing"] {
  if (storedWithoutRouting) {
    return { kind: "stored_without_routing", target: null };
  }
  if (task.assigneeAgentId) {
    return { kind: "assigned", target: task.assignee?.name || task.assigneeAgentId };
  }
  if (task.triageQueueId) {
    return { kind: "triage", target: task.triageQueueId };
  }
  return { kind: "stored_without_routing", target: null };
}

function classifyIssueType(labels: string[], title: string, body: string): "bug" | "feature" | "architecture" | "design" | "documentation" | "maintenance" | "unknown" {
  const haystack = `${labels.join(" ")} ${title} ${body}`.toLowerCase();
  if (/\b(?:bug|fix|regression|error)\b/u.test(haystack)) return "bug";
  if (/\b(?:doc|documentation|readme)\b/u.test(haystack)) return "documentation";
  if (/\b(?:design|ux|ui)\b/u.test(haystack)) return "design";
  if (/\b(?:refactor|chore|maintenance|deps|dependency)\b/u.test(haystack)) return "maintenance";
  if (/\b(?:arch|architecture|infra|platform)\b/u.test(haystack)) return "architecture";
  if (/\b(?:feature|enhancement|improvement)\b/u.test(haystack)) return "feature";
  return "unknown";
}

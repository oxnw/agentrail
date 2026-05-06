/** GitHub issue intake adapter: maps a GitHub issue to the AgentRail task store. */
import crypto from "node:crypto";

import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { AgentTaskQueue } from "./agent-task-queue.ts";

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
}

export interface GitHubIssueIntakeAdapterConfig {
  taskQueue: AgentTaskQueue;
  now?: () => Date;
}

interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

function hasField<Key extends PropertyKey>(value: object, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
  return JSON.stringify(value) ?? "undefined";
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export class GitHubIssueIntakeAdapter {
  private taskQueue: AgentTaskQueue;
  private now: () => Date;

  constructor({ taskQueue, now = () => new Date() }: GitHubIssueIntakeAdapterConfig) {
    this.taskQueue = taskQueue;
    this.now = now;
  }

  async ingest(payload: GitHubIssueIntakePayload, idempotencyKey?: string): Promise<GitHubIssueIntakeResult> {
    if (!payload.issueNumber || typeof payload.issueNumber !== "number") {
      throw new TaskLifecycleError(400, "validation_error", "`issueNumber` is required and must be a number.", {
        availableActions: ["retry"],
      });
    }

    const repository = this.resolveRepository(payload);
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
        return structuredClone(cached.response as GitHubIssueIntakeResult);
      }
    }

    const existing = this.taskQueue.findTaskByIdentifier(identifier);

    if (existing) {
      const hasBody = hasField(payload, "body");
      const hasLabels = hasField(payload, "labels");
      const hasState = hasField(payload, "state");
      const hasAssignees = hasField(payload, "assignees");
      const description = hasBody ? (payload.body ?? "") : existing.description;
      const acceptanceCriteria = hasBody ? this.extractAcceptanceCriteria(payload.body ?? "") : existing.acceptanceCriteria;
      const labels = hasLabels ? (payload.labels ?? []) : (existing.source?.labels ?? []);
      const assigneeLogins = hasAssignees
        ? (payload.assignees ?? []).map(a => a.login)
        : (existing.source?.assignees ?? []);
      const assignee = hasAssignees ? this.mapAssignee(payload.assignees ?? []) : existing.assignee;

      const updated = this.taskQueue.updateTask(existing.id, {
        title: payload.issueTitle ?? existing.title,
        description,
        status: hasState ? this.mapStatus(payload.state) : existing.status,
        priority: hasLabels ? this.mapPriority(payload.labels ?? []) : existing.priority,
        assignee,
        assigneeAgentId: hasAssignees ? assignee.id : existing.assigneeAgentId,
        acceptanceCriteria,
        links: { issue: payload.issueUrl },
        context: {
          project: `${repository.owner}/${repository.repo}`,
          goal: `GitHub issue intake: #${payload.issueNumber}`,
        },
        source: {
          ...existing.source,
          provider: "github",
          owner: repository.owner,
          repo: repository.repo,
          issueNumber: payload.issueNumber,
          labels,
          assignees: assigneeLogins,
          deliveryId: idempotencyKey ?? existing.source?.deliveryId,
          receivedAt: this.now().toISOString(),
        },
      });

      if (!updated) {
        throw new TaskLifecycleError(500, "internal_error", "Failed to update existing task.", { availableActions: ["retry"] });
      }

      const result: GitHubIssueIntakeResult = {
        taskId: updated.id,
        identifier: updated.identifier,
        status: updated.status,
        availableActions: updated.availableActions,
        createdAt: updated.createdAt,
      };

      if (idempotencyStoreKey) {
        this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
      }

      return result;
    }

    const assignee = this.mapAssignee(payload.assignees ?? []);
    const taskRecord = this.taskQueue.createTask({
      identifier,
      title: payload.issueTitle ?? `Issue #${payload.issueNumber}`,
      description: payload.body ?? "",
      status: this.mapStatus(payload.state),
      priority: this.mapPriority(payload.labels ?? []),
      assignee,
      assigneeAgentId: assignee.id,
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
        labels: payload.labels ?? [],
        assignees: (payload.assignees ?? []).map(a => a.login),
        deliveryId: idempotencyKey,
        receivedAt: this.now().toISOString(),
      },
    });

    const result: GitHubIssueIntakeResult = {
      taskId: taskRecord.id,
      identifier: taskRecord.identifier,
      status: taskRecord.status,
      availableActions: taskRecord.availableActions,
      createdAt: taskRecord.createdAt,
    };

    if (idempotencyStoreKey) {
      this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
    }

    return result;
  }

  /** Build a deterministic identifier from the issue URL, e.g. "github:oxnw/agentrail:issues/10". */
  private buildIdentifier(repository: GitHubRepositoryRef, issueNumber: number): string {
    return `github:${repository.owner}/${repository.repo}:issues/${issueNumber}`;
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

  private mapAssignee(assignees: Array<{ login: string }>) {
    if (assignees.length > 0 && assignees[0]!.login) {
      return { id: assignees[0]!.login, name: assignees[0]!.login };
    }
    return { id: "unknown", name: "Unknown" };
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
}

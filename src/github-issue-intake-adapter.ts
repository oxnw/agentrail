/** GitHub issue intake adapter: maps a GitHub issue to the AgentRail task store. */
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

    const identifier = this.buildIdentifier(payload);

    if (idempotencyKey) {
      const cached = this.taskQueue.getIdempotencyEntry(idempotencyKey);
      if (cached) {
        return cached.response as GitHubIssueIntakeResult;
      }
    }

    const existing = this.taskQueue.findTaskByIdentifier(identifier);

    if (existing) {
      const updated = this.taskQueue.updateTask(existing.id, {
        title: payload.issueTitle ?? existing.title,
        description: payload.body ?? existing.description,
        status: this.mapStatus(payload.state),
        priority: this.mapPriority(payload.labels ?? []),
        assignee: this.mapAssignee(payload.assignees ?? []),
        acceptanceCriteria: this.extractAcceptanceCriteria(payload.body ?? ""),
        links: { issue: payload.issueUrl },
        context: {
          project: payload.repository ? `${payload.repository.owner}/${payload.repository.repo}` : existing.context.project,
          goal: `GitHub issue intake: #${payload.issueNumber}`,
        },
        source: {
          provider: "github",
          owner: payload.repository?.owner,
          repo: payload.repository?.repo,
          issueNumber: payload.issueNumber,
          labels: payload.labels ?? [],
          assignees: (payload.assignees ?? []).map(a => a.login),
          deliveryId: idempotencyKey ?? undefined,
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

      if (idempotencyKey) {
        this.taskQueue.setIdempotencyEntry(idempotencyKey, { fingerprint: identifier, response: result });
      }

      return result;
    }

    const taskRecord = this.taskQueue.createTask({
      identifier,
      title: payload.issueTitle ?? `Issue #${payload.issueNumber}`,
      description: payload.body ?? "",
      status: this.mapStatus(payload.state),
      priority: this.mapPriority(payload.labels ?? []),
      assignee: this.mapAssignee(payload.assignees ?? []),
      links: {
        issue: payload.issueUrl,
      },
      context: {
        project: payload.repository ? `${payload.repository.owner}/${payload.repository.repo}` : null,
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
        owner: payload.repository?.owner,
        repo: payload.repository?.repo,
        issueNumber: payload.issueNumber,
        labels: payload.labels ?? [],
        assignees: (payload.assignees ?? []).map(a => a.login),
        deliveryId: idempotencyKey ?? undefined,
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

    if (idempotencyKey) {
      this.taskQueue.setIdempotencyEntry(idempotencyKey, { fingerprint: identifier, response: result });
    }

    return result;
  }

  /** Build a deterministic identifier from the issue URL, e.g. "github:oxnw/agentrail:issues/10". */
  private buildIdentifier(payload: GitHubIssueIntakePayload): string {
    if (payload.repository) {
      return `github:${payload.repository.owner}/${payload.repository.repo}:issues/${payload.issueNumber}`;
    }
    try {
      const url = new URL(payload.issueUrl);
      const parts = url.pathname.split("/");
      const [_, owner, repo] = parts;
      if (owner && repo) {
        return `github:${owner}/${repo}:issues/${payload.issueNumber}`;
      }
    } catch {
      // fall through
    }
    return `github:issues/${payload.issueNumber}`;
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

import crypto from "node:crypto";

import type { RoutingControlPlane } from "./intake-routing-control-plane.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { AgentTaskQueue } from "./agent-task-queue.ts";
import type { TaskPriority, TaskRecord, TaskStatus } from "./task-store.ts";

const DEFAULT_LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const WEBHOOK_REPLAY_WINDOW_MS = 60_000;

export interface LinearIssueSourceAdapterConfig {
  taskQueue: AgentTaskQueue;
  routingControlPlane?: RoutingControlPlane | null;
  routingMode?: "optional" | "required";
  linearApiKey?: string | null;
  webhookSecret?: string | null;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  now?: () => Date;
}

export interface LinearIssueIntakeResult {
  taskId: string;
  identifier: string;
  status: TaskStatus;
  availableActions: string[];
  createdAt: string;
  outcome?: "created" | "updated" | "unchanged";
  routing?: {
    kind: "assigned" | "triage" | "stored_without_routing";
    target: string | null;
  };
}

export interface LinearImportSelectorResult extends LinearIssueIntakeResult {
  linearIssueId: string;
}

type LinearIssueUpsertResult = LinearIssueIntakeResult & {
  fromIdempotencyCache: boolean;
};

interface LinearWebhookInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

interface LinearWebhookResult {
  data: {
    matchedTasks: string[];
    deduplicated: boolean;
    ignored: boolean;
    deliveryId: string | null;
    eventType: string | null;
  };
  availableActions: string[];
}

function hasField<Key extends PropertyKey>(value: object, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
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

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | null {
  const lowerKey = key.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== lowerKey) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

export class LinearIssueSourceAdapter {
  private taskQueue: AgentTaskQueue;
  private routingControlPlane: RoutingControlPlane | null;
  private routingMode: "optional" | "required";
  private linearApiKey: string | null;
  private webhookSecret: string | null;
  private fetch: typeof globalThis.fetch;
  private apiBaseUrl: string;
  private now: () => Date;

  constructor({
    taskQueue,
    routingControlPlane = null,
    routingMode = "optional",
    linearApiKey = process.env.LINEAR_API_KEY || null,
    webhookSecret = process.env.LINEAR_WEBHOOK_SECRET || null,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_LINEAR_GRAPHQL_URL,
    now = () => new Date(),
  }: LinearIssueSourceAdapterConfig) {
    if (typeof fetch !== "function") {
      throw new TypeError("LinearIssueSourceAdapter requires a fetch implementation.");
    }
    this.taskQueue = taskQueue;
    this.routingControlPlane = routingControlPlane;
    this.routingMode = routingMode;
    this.linearApiKey = linearApiKey;
    this.webhookSecret = webhookSecret;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl;
    this.now = now;
  }

  async ingest(payload: unknown, idempotencyKey?: string): Promise<LinearIssueIntakeResult> {
    const issue = this.normalizeIssue(payload);
    return stripUpsertMetadata(await this.upsertNormalizedIssue(issue, idempotencyKey));
  }

  async importIssue(selector: string, idempotencyKey?: string): Promise<LinearImportSelectorResult> {
    const issue = await this.fetchIssue(this.normalizeIssueSelector(selector));
    const result = stripUpsertMetadata(await this.upsertNormalizedIssue(issue, idempotencyKey));
    return {
      ...result,
      linearIssueId: issue.id,
    };
  }

  async refreshIssue(issueId: string): Promise<LinearIssueIntakeResult> {
    const issue = await this.fetchIssue(issueId.trim());
    return stripUpsertMetadata(await this.upsertNormalizedIssue(issue));
  }

  private async upsertNormalizedIssue(
    issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>,
    idempotencyKey?: string,
  ): Promise<LinearIssueUpsertResult> {
    const fingerprint = sha256(issue.raw);
    const idempotencyStoreKey = idempotencyKey ? `linear-issue-intake:${idempotencyKey}` : null;

    if (idempotencyStoreKey) {
      const cached = this.taskQueue.getIdempotencyEntry(idempotencyStoreKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different Linear issue intake payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return {
          ...structuredClone(cached.response as LinearIssueIntakeResult),
          fromIdempotencyCache: true,
        };
      }
    }

    const existing = this.taskQueue.findTaskByLinearIssueId(issue.id) ?? this.taskQueue.findTaskByIdentifier(issue.identifier);
    const result = existing
      ? this.updateExistingTask(existing, issue, idempotencyKey)
      : await this.createTask(issue, idempotencyKey);

    if (idempotencyStoreKey) {
      this.taskQueue.setIdempotencyEntry(idempotencyStoreKey, { fingerprint, response: structuredClone(result) });
    }

    return {
      ...result,
      fromIdempotencyCache: false,
    };
  }

  async receiveWebhook({ rawBody, headers }: LinearWebhookInput): Promise<LinearWebhookResult> {
    this.verifyWebhook(rawBody, headers);

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("not an object");
      }
      payload = parsed;
    } catch {
      throw new TaskLifecycleError(400, "validation_error", "Linear webhook payload must be valid JSON.", {
        availableActions: ["retry"],
      });
    }

    const deliveryId = headerValue(headers, "linear-delivery");
    const eventType = headerValue(headers, "linear-event") ?? nonEmptyString(payload.type);
    const action = nonEmptyString(payload.action)?.toLowerCase();

    if (eventType === "Issue") {
      if (action && !["create", "update"].includes(action)) {
        return {
          data: {
            matchedTasks: [],
            deduplicated: false,
            ignored: true,
            deliveryId,
            eventType,
          },
          availableActions: [],
        };
      }
      const issue = this.normalizeIssue(payload.data);
      const result = await this.upsertNormalizedIssue(issue, deliveryId ?? undefined);
      return {
        data: {
          matchedTasks: [result.taskId],
          deduplicated: result.fromIdempotencyCache,
          ignored: false,
          deliveryId,
          eventType,
        },
        availableActions: ["get_task"],
      };
    }

    if (eventType === "Comment") {
      const issueId = isRecord(payload.data) ? nonEmptyString(payload.data.issueId) : null;
      const task = issueId ? this.taskQueue.findTaskByLinearIssueId(issueId) : null;
      return {
        data: {
          matchedTasks: task ? [task.id] : [],
          deduplicated: false,
          ignored: true,
          deliveryId,
          eventType,
        },
        availableActions: task ? ["get_task"] : [],
      };
    }

    return {
      data: {
        matchedTasks: [],
        deduplicated: false,
        ignored: true,
        deliveryId,
        eventType,
      },
      availableActions: [],
    };
  }

  async createComment(issueId: string, body: string) {
    const response = await this.graphql(
      `mutation LinearCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
            url
          }
        }
      }`,
      {
        input: {
          issueId,
          body,
        },
      },
    );
    const data = recordOrNull(response.data);
    const commentCreate = recordOrNull(data?.commentCreate);
    const comment = recordOrNull(commentCreate?.comment);
    return {
      data: {
        commentId: comment?.id ?? null,
        commentUrl: comment?.url ?? null,
        success: Boolean(commentCreate?.success),
      },
      availableActions: ["get_task"],
    };
  }

  async updateIssueState(issueId: string, stateId: string) {
    const response = await this.graphql(
      `mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            state {
              id
              name
              type
            }
          }
        }
      }`,
      {
        id: issueId,
        input: {
          stateId,
        },
      },
    );
    const data = recordOrNull(response.data);
    const issueUpdate = recordOrNull(data?.issueUpdate);
    const issue = recordOrNull(issueUpdate?.issue);
    const state = recordOrNull(issue?.state);
    return {
      data: {
        issueId: issue?.id ?? null,
        stateId: state?.id ?? null,
        stateName: state?.name ?? null,
        agentRailStatus: this.mapStatus(nonEmptyString(state?.type), nonEmptyString(state?.name)),
        success: Boolean(issueUpdate?.success),
      },
      availableActions: ["get_task"],
    };
  }

  private normalizeIssue(payload: unknown) {
    if (!isRecord(payload)) {
      throw new TaskLifecycleError(400, "validation_error", "Linear issue payload must be an object.", {
        availableActions: ["retry"],
      });
    }

    const id = nonEmptyString(payload.id);
    const linearIdentifier = nonEmptyString(payload.identifier);
    const title = nonEmptyString(payload.title);
    const url = nonEmptyString(payload.url);
    if (!id) {
      throw new TaskLifecycleError(400, "validation_error", "Linear issue payload requires a non-empty `id`.", {
        availableActions: ["retry"],
      });
    }
    if (!title) {
      throw new TaskLifecycleError(400, "validation_error", "Linear issue payload requires a non-empty `title`.", {
        availableActions: ["retry"],
      });
    }

    const state = isRecord(payload.state) ? payload.state : null;
    const team = isRecord(payload.team) ? payload.team : null;
    const workspace = isRecord(payload.workspace) || isRecord(payload.organization)
      ? (isRecord(payload.workspace) ? payload.workspace : payload.organization as Record<string, unknown>)
      : null;

    const teamKey = nonEmptyString(team?.key);
    const workspaceUrlKey = nonEmptyString(workspace?.urlKey) ?? this.workspaceFromUrl(url);
    const displayIdentifier = linearIdentifier ?? id;
    const identifierPrefix = workspaceUrlKey ?? teamKey ?? "workspace";

    return {
      raw: payload,
      id,
      linearIdentifier,
      identifier: `linear:${identifierPrefix}:issues/${displayIdentifier}`,
      title,
      description: typeof payload.description === "string" ? payload.description : "",
      url: url ?? (workspaceUrlKey
        ? `https://linear.app/${workspaceUrlKey}/issue/${displayIdentifier}`
        : `https://linear.app/issue/${displayIdentifier}`),
      status: this.mapStatus(nonEmptyString(state?.type), nonEmptyString(state?.name)),
      priority: this.mapPriority(payload.priority, payload.priorityLabel, this.extractLabels(payload.labels)),
      assignee: this.mapAssignee(payload.assignee),
      acceptanceCriteria: this.extractAcceptanceCriteria(typeof payload.description === "string" ? payload.description : ""),
      labels: this.extractLabels(payload.labels),
      teamId: nonEmptyString(team?.id),
      teamKey,
      teamName: nonEmptyString(team?.name),
      workspaceId: nonEmptyString(workspace?.id),
      workspaceUrlKey,
      workflowStateId: nonEmptyString(state?.id),
      workflowStateName: nonEmptyString(state?.name),
      workflowStateType: nonEmptyString(state?.type),
      hasDescription: hasField(payload, "description"),
      hasLabels: hasField(payload, "labels"),
      hasAssignee: hasField(payload, "assignee"),
      hasState: hasField(payload, "state"),
      hasPriority: hasField(payload, "priority") || hasField(payload, "priorityLabel"),
    };
  }

  private normalizeIssueSelector(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new TaskLifecycleError(400, "validation_error", "Linear issue selector must be a non-empty string.", {
        availableActions: ["retry"],
      });
    }

    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split("/").filter(Boolean);
      const issueIndex = segments.findIndex((segment) => segment === "issue");
      const identifier = issueIndex >= 0 ? nonEmptyString(segments[issueIndex + 1]) : null;
      if (!identifier) {
        throw new TaskLifecycleError(400, "validation_error", "Linear issue URL must include an issue identifier segment.", {
          availableActions: ["retry"],
        });
      }
      return identifier;
    } catch (error) {
      if (error instanceof TaskLifecycleError) throw error;
      return trimmed;
    }
  }

  private async createTask(issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>, deliveryId?: string): Promise<LinearIssueIntakeResult> {
    const routedTaskId = await this.routeIssueIfConfigured(issue, deliveryId);
    const baseTask = routedTaskId
      ? this.taskQueue.getRawTask(routedTaskId)
      : null;
    const task = baseTask ?? this.taskQueue.createTask({
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      assigneeAgentId: null,
      links: { issue: issue.url },
      context: {
        project: issue.teamKey ?? issue.teamName ?? issue.workspaceUrlKey,
        goal: `Linear issue intake: ${issue.linearIdentifier ?? issue.id}`,
      },
      acceptanceCriteria: issue.acceptanceCriteria,
      createdAt: this.now().toISOString(),
      availableActions: this.availableActions(issue.status),
      submissions: [],
      latestSubmissionId: null,
      ciStatus: null,
      reviewOutcome: null,
      shipOperation: null,
      rollbackOperation: null,
      dueAt: null,
      version: 1,
      source: this.buildLinearSource(issue, null, { deliveryId }),
    });

    if (baseTask) {
      const assignee = this.preserveAgentRailAssignee(baseTask, issue.assignee);
      const updated = this.taskQueue.updateTask(baseTask.id, {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        assignee,
        acceptanceCriteria: issue.acceptanceCriteria,
        links: { issue: issue.url },
        context: {
          project: issue.teamKey ?? issue.teamName ?? issue.workspaceUrlKey,
          goal: `Linear issue intake: ${issue.linearIdentifier ?? issue.id}`,
        },
        availableActions: this.availableActions(issue.status),
        source: this.buildLinearSource(issue, baseTask, { deliveryId }),
      });
      return this.resultFor(updated ?? task, "created", describeRouting(updated ?? task, false));
    }

    return this.resultFor(task, "created", describeRouting(task, !routedTaskId));
  }

  private async routeIssueIfConfigured(
    issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>,
    deliveryId?: string,
  ): Promise<string | null> {
    if (!this.routingControlPlane) {
      if (this.routingMode === "required") {
        throw new TaskLifecycleError(503, "misconfigured", "Provider issue routing is required but the routing control plane is not configured.", {
          availableActions: ["configure_routing"],
        });
      }
      return null;
    }
    const project = issue.teamKey ?? issue.teamName ?? issue.workspaceUrlKey ?? "linear";
    const snapshotIdentifier = issue.identifier;
    try {
      const decision = await this.routingControlPlane.ingestProviderIssue({
        provider: "linear",
        providerIssueId: snapshotIdentifier,
        sourceVersion: deliveryId ?? `${this.now().toISOString()}:linear`,
        repository: {
          provider: "linear",
          owner: issue.workspaceUrlKey ?? "linear",
          name: issue.teamKey ?? issue.teamName ?? "workspace",
          defaultBranch: "main",
        },
        title: issue.title,
        bodyDigest: sha256(issue.description),
        labels: issue.labels,
        project,
        issueType: classifyLinearIssueType(issue.labels, issue.title, issue.description),
        priority: issue.priority,
        ownershipTags: [],
        capabilityTags: [],
        links: {
          providerIssue: issue.url,
        },
      }, deliveryId ? `linear-route:${deliveryId}` : undefined);
      return decision.taskId;
    } catch (error) {
      if (this.routingMode === "optional" && error instanceof TaskLifecycleError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private updateExistingTask(existing: TaskRecord, issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>, deliveryId?: string): LinearIssueIntakeResult {
    const nextTaskState = {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.hasDescription ? issue.description : existing.description,
      status: issue.hasState ? issue.status : existing.status,
      priority: issue.hasPriority || issue.hasLabels ? issue.priority : existing.priority,
      assignee: issue.hasAssignee ? this.preserveAgentRailAssignee(existing, issue.assignee) : existing.assignee,
      acceptanceCriteria: issue.hasDescription ? issue.acceptanceCriteria : existing.acceptanceCriteria,
      links: { issue: issue.url },
      context: {
        project: issue.teamKey ?? issue.teamName ?? issue.workspaceUrlKey ?? existing.context.project,
        goal: `Linear issue intake: ${issue.linearIdentifier ?? issue.id}`,
      },
      availableActions: issue.hasState ? this.availableActions(issue.status) : existing.availableActions,
      source: this.buildComparableLinearSource(issue, existing),
    };
    if (linearTaskStateMatches(existing, nextTaskState)) {
      return this.resultFor(existing, "unchanged", describeRouting(existing, false));
    }

    const updated = this.taskQueue.updateTask(existing.id, {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.hasDescription ? issue.description : existing.description,
      status: issue.hasState ? issue.status : existing.status,
      priority: issue.hasPriority || issue.hasLabels ? issue.priority : existing.priority,
      assignee: issue.hasAssignee ? this.preserveAgentRailAssignee(existing, issue.assignee) : existing.assignee,
      assigneeAgentId: this.resolveCanonicalAssigneeAgentId(existing),
      acceptanceCriteria: issue.hasDescription ? issue.acceptanceCriteria : existing.acceptanceCriteria,
      links: { ...existing.links, issue: issue.url },
      context: {
        project: issue.teamKey ?? issue.teamName ?? issue.workspaceUrlKey ?? existing.context.project,
        goal: `Linear issue intake: ${issue.linearIdentifier ?? issue.id}`,
      },
      availableActions: issue.hasState ? this.availableActions(issue.status) : existing.availableActions,
      source: this.buildLinearSource(issue, existing, { deliveryId }),
    });

    if (!updated) {
      throw new TaskLifecycleError(500, "internal_error", "Failed to update existing Linear task.", {
        availableActions: ["retry"],
      });
    }

    return this.resultFor(updated, "updated", describeRouting(updated, false));
  }

  private resultFor(
    task: TaskRecord,
    outcome: "created" | "updated" | "unchanged",
    routing: LinearIssueIntakeResult["routing"],
  ): LinearIssueIntakeResult {
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

  private verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
    if (!this.webhookSecret) {
      throw new TaskLifecycleError(503, "misconfigured", "LINEAR_WEBHOOK_SECRET is required for Linear webhook intake.", {
        availableActions: ["contact_support"],
      });
    }
    const signature = headerValue(headers, "linear-signature");
    if (!signature || !/^[a-f0-9]+$/iu.test(signature)) {
      throw this.unauthorizedWebhook();
    }

    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      throw this.unauthorizedWebhook();
    }

    try {
      const parsed = JSON.parse(rawBody) as unknown;
      const timestamp = isRecord(parsed) && typeof parsed.webhookTimestamp === "number" ? parsed.webhookTimestamp : null;
      if (timestamp == null || Math.abs(this.now().getTime() - timestamp) > WEBHOOK_REPLAY_WINDOW_MS) {
        throw this.unauthorizedWebhook();
      }
    } catch (error) {
      if (error instanceof TaskLifecycleError) throw error;
      throw new TaskLifecycleError(400, "validation_error", "Linear webhook payload must be valid JSON.", {
        availableActions: ["retry"],
      });
    }
  }

  private unauthorizedWebhook() {
    return new TaskLifecycleError(401, "linear_webhook_unauthorized", "Linear webhook signature is missing, invalid, or outside the replay window.", {
      availableActions: ["retry"],
    });
  }

  private resolveCanonicalAssigneeAgentId(existing: TaskRecord): string | null {
    const assigneeAgentId = existing.assigneeAgentId ?? null;
    if (!assigneeAgentId) return null;
    if (existing.assignmentSource) return assigneeAgentId;
    return /^agt_/iu.test(assigneeAgentId) ? assigneeAgentId : null;
  }

  private preserveAgentRailAssignee(existing: TaskRecord, upstreamAssignee: TaskRecord["assignee"]): TaskRecord["assignee"] {
    return this.resolveCanonicalAssigneeAgentId(existing) ? existing.assignee : upstreamAssignee;
  }

  private buildLinearSource(
    issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>,
    existing: TaskRecord | null,
    {
      deliveryId,
      preserveReceiptMetadata = false,
    }: {
      deliveryId?: string;
      preserveReceiptMetadata?: boolean;
    } = {},
  ): NonNullable<TaskRecord["source"]> {
    return {
      ...existing?.source,
      provider: "linear",
      linearIssueId: issue.id,
      linearIdentifier: issue.linearIdentifier ?? existing?.source?.linearIdentifier ?? null,
      linearTeamId: issue.teamId ?? existing?.source?.linearTeamId ?? null,
      linearTeamKey: issue.teamKey ?? existing?.source?.linearTeamKey ?? null,
      linearWorkspaceId: issue.workspaceId ?? existing?.source?.linearWorkspaceId ?? null,
      linearWorkspaceUrlKey: issue.workspaceUrlKey ?? existing?.source?.linearWorkspaceUrlKey ?? null,
      workflowStateId: issue.workflowStateId ?? existing?.source?.workflowStateId ?? null,
      workflowStateName: issue.workflowStateName ?? existing?.source?.workflowStateName ?? null,
      workflowStateType: issue.workflowStateType ?? existing?.source?.workflowStateType ?? null,
      labels: issue.hasLabels ? issue.labels : existing?.source?.labels ?? [],
      assignees: issue.hasAssignee
        ? (issue.assignee.id === "unknown" ? [] : [issue.assignee.id])
        : existing?.source?.assignees ?? [],
      deliveryId: preserveReceiptMetadata
        ? existing?.source?.deliveryId ?? null
        : deliveryId ?? existing?.source?.deliveryId ?? null,
      receivedAt: preserveReceiptMetadata
        ? existing?.source?.receivedAt ?? null
        : this.now().toISOString(),
    };
  }

  private buildComparableLinearSource(
    issue: ReturnType<LinearIssueSourceAdapter["normalizeIssue"]>,
    existing: TaskRecord,
  ): NonNullable<TaskRecord["source"]> {
    return {
      provider: "linear",
      linearIssueId: issue.id,
      linearIdentifier: issue.linearIdentifier ?? existing.source?.linearIdentifier ?? null,
      linearTeamId: issue.teamId ?? existing.source?.linearTeamId ?? null,
      linearTeamKey: issue.teamKey ?? existing.source?.linearTeamKey ?? null,
      linearWorkspaceId: issue.workspaceId ?? existing.source?.linearWorkspaceId ?? null,
      linearWorkspaceUrlKey: issue.workspaceUrlKey ?? existing.source?.linearWorkspaceUrlKey ?? null,
      workflowStateId: issue.workflowStateId ?? existing.source?.workflowStateId ?? null,
      workflowStateName: issue.workflowStateName ?? existing.source?.workflowStateName ?? null,
      workflowStateType: issue.workflowStateType ?? existing.source?.workflowStateType ?? null,
      labels: issue.hasLabels ? issue.labels : existing.source?.labels ?? [],
      assignees: issue.hasAssignee
        ? (issue.assignee.id === "unknown" ? [] : [issue.assignee.id])
        : existing.source?.assignees ?? [],
    };
  }

  private async graphql(query: string, variables: Record<string, unknown>) {
    if (!this.linearApiKey) {
      throw new TaskLifecycleError(500, "misconfigured", "LINEAR_API_KEY is required for Linear GraphQL mutations.", {
        availableActions: ["contact_support"],
      });
    }

    const response = await this.fetch(this.apiBaseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.linearApiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed = text ? JSON.parse(text) as unknown : {};
      body = isRecord(parsed) ? parsed : {};
    } catch {
      body = {};
    }

    if (!response.ok || Array.isArray(body.errors)) {
      throw new TaskLifecycleError(
        response.status === 429 ? 429 : 502,
        response.status === 429 ? "rate_limited" : "upstream_error",
        `Linear GraphQL error: ${response.status} ${text.slice(0, 200)}`,
        { availableActions: ["retry"] },
      );
    }

    return body;
  }

  private async fetchIssue(selector: string) {
    const response = await this.graphql(
      `query LinearIssueImport($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          state {
            id
            name
            type
          }
          team {
            id
            key
            name
          }
          assignee {
            id
            name
          }
          labels {
            nodes {
              name
            }
          }
          organization {
            id
            urlKey
          }
        }
      }`,
      {
        id: selector,
      },
    );

    const issue = recordOrNull(recordOrNull(response.data)?.issue);
    if (!issue) {
      throw new TaskLifecycleError(404, "not_found", `Linear issue "${selector}" was not found.`, {
        availableActions: ["retry"],
      });
    }

    return this.normalizeIssue(issue);
  }

  private mapStatus(stateType: string | null, stateName: string | null): TaskStatus {
    const normalizedName = stateName?.toLowerCase() ?? "";
    if (normalizedName.includes("block")) return "blocked";
    switch (stateType) {
      case "started": return "in_progress";
      case "completed": return "done";
      case "canceled": return "cancelled";
      case "triage":
      case "backlog":
      case "unstarted":
      default:
        return "todo";
    }
  }

  private mapPriority(priority: unknown, priorityLabel: unknown, labels: string[]): TaskPriority {
    const label = typeof priorityLabel === "string" ? priorityLabel.toLowerCase() : "";
    const labelText = [...labels.map(item => item.toLowerCase()), label].join(" ");
    if (priority === 1 || /\b(?:urgent|critical|p0)\b/u.test(labelText)) return "critical";
    if (priority === 2 || /\b(?:high|p1)\b/u.test(labelText)) return "high";
    if (priority === 3 || /\b(?:normal|medium|p2)\b/u.test(labelText)) return "medium";
    if (priority === 4 || /\b(?:low|p3|p4)\b/u.test(labelText)) return "low";
    return "medium";
  }

  private mapAssignee(value: unknown) {
    if (!isRecord(value)) {
      return { id: "unknown", name: "Unknown" };
    }
    const id = nonEmptyString(value.id) ?? nonEmptyString(value.name);
    const name = nonEmptyString(value.name) ?? id;
    return id ? { id, name: name ?? id } : { id: "unknown", name: "Unknown" };
  }

  private extractLabels(value: unknown): string[] {
    const nodes = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.nodes)
        ? value.nodes
        : [];
    return nodes
      .map(item => isRecord(item) ? nonEmptyString(item.name) : nonEmptyString(item))
      .filter((item): item is string => Boolean(item));
  }

  private availableActions(status: TaskStatus): string[] {
    switch (status) {
      case "todo": return ["start"];
      case "in_progress":
      case "blocked":
      case "in_review":
        return ["submit"];
      case "done":
      case "cancelled":
        return [];
    }
  }

  private workspaceFromUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts[0] ?? null;
    } catch {
      return null;
    }
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

function linearTaskStateMatches(existing: TaskRecord, next: Record<string, unknown>): boolean {
  return stableStringify({
    identifier: existing.identifier,
    title: existing.title,
    description: existing.description,
    status: existing.status,
    priority: existing.priority,
    assignee: existing.assignee,
    acceptanceCriteria: existing.acceptanceCriteria,
    links: { issue: existing.links.issue },
    context: existing.context,
    availableActions: existing.availableActions,
    source: {
      provider: existing.source?.provider ?? null,
      linearIssueId: existing.source?.linearIssueId ?? null,
      linearIdentifier: existing.source?.linearIdentifier ?? null,
      linearTeamId: existing.source?.linearTeamId ?? null,
      linearTeamKey: existing.source?.linearTeamKey ?? null,
      linearWorkspaceId: existing.source?.linearWorkspaceId ?? null,
      linearWorkspaceUrlKey: existing.source?.linearWorkspaceUrlKey ?? null,
      workflowStateId: existing.source?.workflowStateId ?? null,
      workflowStateName: existing.source?.workflowStateName ?? null,
      workflowStateType: existing.source?.workflowStateType ?? null,
      labels: existing.source?.labels ?? [],
      assignees: existing.source?.assignees ?? [],
    },
  }) === stableStringify(next);
}

function describeRouting(task: TaskRecord, storedWithoutRouting: boolean): LinearIssueIntakeResult["routing"] {
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

function classifyLinearIssueType(labels: string[], title: string, description: string): "bug" | "feature" | "architecture" | "design" | "documentation" | "maintenance" | "unknown" {
  const haystack = `${labels.join(" ")} ${title} ${description}`.toLowerCase();
  if (/\b(?:bug|fix|regression|incident)\b/.test(haystack)) return "bug";
  if (/\b(?:doc|documentation|readme)\b/.test(haystack)) return "documentation";
  if (/\b(?:design|ux|ui)\b/.test(haystack)) return "design";
  if (/\b(?:refactor|chore|maintenance|deps|dependency)\b/.test(haystack)) return "maintenance";
  if (/\b(?:arch|architecture|infra|platform)\b/.test(haystack)) return "architecture";
  if (/\b(?:feature|enhancement|improvement)\b/.test(haystack)) return "feature";
  return "unknown";
}

function stripUpsertMetadata(result: LinearIssueUpsertResult): LinearIssueIntakeResult {
  const { fromIdempotencyCache: _fromIdempotencyCache, ...publicResult } = result;
  return publicResult;
}

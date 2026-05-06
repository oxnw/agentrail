import crypto from "node:crypto";

import type { AgentTaskQueue } from "./agent-task-queue.ts";
import { TaskLifecycleError } from "./task-lifecycle-errors.ts";
import type { TaskAssignmentSource } from "./task-store.ts";

export interface ProviderRepository {
  provider: "github" | "gitlab";
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ProviderIssueSnapshot {
  provider: "github" | "linear" | "jira" | "gitlab";
  providerIssueId: string;
  sourceVersion: string;
  repository: ProviderRepository;
  title: string;
  bodyDigest: string;
  labels: string[];
  providerAssignees: string[];
  project?: string | null;
  issueType: "bug" | "feature" | "architecture" | "design" | "documentation" | "maintenance" | "unknown";
  priority: "low" | "medium" | "high" | "critical";
  ownershipTags: string[];
  capabilityTags: string[];
  links: {
    providerIssue: string;
  };
}

export interface ProviderIdentityMapping {
  provider: string;
  subject: string;
}

export interface AgentProfileReplaceRequest {
  displayName: string;
  role: string;
  status: "active" | "paused" | "disabled";
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  providerIdentityMappings: ProviderIdentityMapping[];
  maxConcurrentTasks: number;
  sourceRef: string;
  changeReason: string;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  role: string;
  status: "active" | "paused" | "disabled";
  capabilityTags: string[];
  ownershipTags: string[];
  repoAllowlist: string[];
  providerIdentityMappings: ProviderIdentityMapping[];
  maxConcurrentTasks: number;
  source: "agent_created" | "operator_admin" | "skill_assignment_sync" | "config_file_import";
  sourceRef: string;
  updatedBy: string;
  updatedAt: string;
}

export interface RoutingTarget {
  type: "agent" | "triage_queue";
  id: string;
}

export interface RoutingConditions {
  repositories?: string[];
  labelsAny?: string[];
  providerAssigneesAny?: string[];
  projects?: string[];
  issueTypes?: string[];
  priorities?: string[];
  ownershipTagsAny?: string[];
  capabilityTagsAll?: string[];
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RoutingConditions;
  target: RoutingTarget;
  confidence: number;
  explanation: string;
}

export interface ClassifierConfig {
  enabled: boolean;
  provider: string;
  confidenceThreshold: number;
  maxCandidates: number;
  fallbackTriageQueueId: string;
}

export interface RoutingRuleSetReplaceRequest {
  sourceRef: string;
  changeReason: string;
  rules: RoutingRule[];
  classifier: ClassifierConfig;
}

export interface RoutingRuleSet {
  id: string;
  version: number;
  status: "active" | "superseded";
  source: "admin_api" | "config_file_import" | "database_seed";
  sourceRef: string;
  createdBy: string;
  createdAt: string;
  rules: RoutingRule[];
  classifier: ClassifierConfig;
  audit: {
    supersedesRuleSetId: string | null;
    changeReason: string;
  };
}

export interface ClassifierResult {
  provider: string;
  confidence: number;
  suggestedTarget: RoutingTarget;
}

export interface RoutingReason {
  summary: string;
  matchedRules: Array<{ id: string; name: string; confidence: number }>;
  classifier: ClassifierResult | null;
  conflictReasons: string[];
}

export interface TaskAssignment {
  assigneeAgentId: string | null;
  triageQueueId: string | null;
  assignmentSource: TaskAssignmentSource;
  routingDecisionId: string;
  assignedAt: string | null;
}

export interface RoutingDecision {
  id: string;
  taskId: string | null;
  taskIdentifier: string | null;
  outcome: "assigned" | "triage" | "conflict" | "no_route";
  target: RoutingTarget;
  assignment: TaskAssignment;
  confidence: number;
  routingReason: RoutingReason;
  availableActions: string[];
}

export interface RoutingAuditRecord {
  decision: RoutingDecision;
  inputDigest: string;
  ruleSet: {
    id: string;
    version: number;
  };
  createdAt: string;
}

export interface RoutingEvaluationRequest {
  ruleSetVersion?: number | null;
  snapshot: ProviderIssueSnapshot;
}

interface IdempotencyEntry<T> {
  fingerprint: string;
  response: T;
}

export interface RoutingControlPlaneOptions {
  now?: () => Date;
  taskQueue: AgentTaskQueue;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
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

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function matchesAny(candidates: string[], actual: string[]): boolean {
  const actualSet = new Set(actual.map(lower));
  return candidates.some(candidate => actualSet.has(lower(candidate)));
}

function matchesAll(required: string[], actual: string[]): boolean {
  const actualSet = new Set(actual.map(lower));
  return required.every(candidate => actualSet.has(lower(candidate)));
}

function repoKey(snapshot: ProviderIssueSnapshot): string {
  return `${snapshot.repository.owner}/${snapshot.repository.name}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class RoutingControlPlane {
  private readonly now: () => Date;
  private readonly taskQueue: AgentTaskQueue;
  private readonly profiles: Map<string, AgentProfile>;
  private readonly audits: Map<string, RoutingAuditRecord>;
  private readonly idempotency: Map<string, IdempotencyEntry<unknown>>;
  private ruleSets: RoutingRuleSet[];

  constructor({ now = () => new Date(), taskQueue }: RoutingControlPlaneOptions) {
    this.now = now;
    this.taskQueue = taskQueue;
    this.profiles = new Map();
    this.audits = new Map();
    this.idempotency = new Map();
    this.ruleSets = [];
  }

  getCurrentRuleSet(): RoutingRuleSet | null {
    return this.ruleSets.length > 0 ? clone(this.ruleSets[this.ruleSets.length - 1]!) : null;
  }

  replaceRuleSet(payload: RoutingRuleSetReplaceRequest, createdBy: string, idempotencyKey?: string): RoutingRuleSet {
    this.validateRuleSetPayload(payload);
    const fingerprint = sha256(payload);

    if (idempotencyKey) {
      const entry = this.idempotency.get(`rule-set:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different routing rule set payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response as RoutingRuleSet);
      }
    }

    const previous = this.ruleSets.at(-1) ?? null;
    if (previous) {
      previous.status = "superseded";
    }

    const next: RoutingRuleSet = {
      id: createId("rset"),
      version: previous ? previous.version + 1 : 1,
      status: "active",
      source: "admin_api",
      sourceRef: payload.sourceRef,
      createdBy,
      createdAt: this.now().toISOString(),
      rules: clone(payload.rules),
      classifier: clone(payload.classifier),
      audit: {
        supersedesRuleSetId: previous?.id ?? null,
        changeReason: payload.changeReason,
      },
    };
    this.ruleSets.push(next);

    if (idempotencyKey) {
      this.idempotency.set(`rule-set:${idempotencyKey}`, {
        fingerprint,
        response: clone(next),
      });
    }

    return clone(next);
  }

  getAgentProfile(agentId: string): AgentProfile | null {
    return this.profiles.has(agentId) ? clone(this.profiles.get(agentId)!) : null;
  }

  replaceAgentProfile(agentId: string, payload: AgentProfileReplaceRequest, updatedBy: string): AgentProfile {
    this.validateAgentProfilePayload(agentId, payload);
    const profile: AgentProfile = {
      agentId,
      displayName: payload.displayName,
      role: payload.role,
      status: payload.status,
      capabilityTags: clone(payload.capabilityTags),
      ownershipTags: clone(payload.ownershipTags),
      repoAllowlist: clone(payload.repoAllowlist),
      providerIdentityMappings: clone(payload.providerIdentityMappings),
      maxConcurrentTasks: payload.maxConcurrentTasks,
      source: "operator_admin",
      sourceRef: payload.sourceRef,
      updatedBy,
      updatedAt: this.now().toISOString(),
    };
    this.profiles.set(agentId, profile);
    return clone(profile);
  }

  async evaluate({ ruleSetVersion, snapshot }: RoutingEvaluationRequest): Promise<RoutingDecision> {
    const ruleSet = this.resolveCurrentRuleSet(ruleSetVersion);
    const { decision } = this.routeSnapshot(snapshot, ruleSet);
    return clone(decision);
  }

  async ingestProviderIssue(snapshot: ProviderIssueSnapshot, idempotencyKey?: string): Promise<RoutingDecision> {
    this.validateSnapshot(snapshot);
    const fingerprint = sha256(snapshot);

    if (idempotencyKey) {
      const entry = this.idempotency.get(`intake:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different provider issue snapshot.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response as RoutingDecision);
      }
    }

    const ruleSet = this.resolveCurrentRuleSet(null);
    const { decision, inputDigest } = this.routeSnapshot(snapshot, ruleSet);
    const task = this.applyDecisionToTask(snapshot, decision);
    decision.taskId = task.id;
    decision.taskIdentifier = task.identifier;

    const audit: RoutingAuditRecord = {
      decision: clone(decision),
      inputDigest,
      ruleSet: {
        id: ruleSet.id,
        version: ruleSet.version,
      },
      createdAt: this.now().toISOString(),
    };
    this.audits.set(decision.id, audit);

    if (idempotencyKey) {
      this.idempotency.set(`intake:${idempotencyKey}`, {
        fingerprint,
        response: clone(decision),
      });
    }

    return clone(decision);
  }

  getRoutingAudit(decisionId: string): RoutingAuditRecord | null {
    return this.audits.has(decisionId) ? clone(this.audits.get(decisionId)!) : null;
  }

  private resolveCurrentRuleSet(expectedVersion: number | null | undefined): RoutingRuleSet {
    const current = this.getCurrentRuleSet();
    if (!current) {
      throw new TaskLifecycleError(404, "not_found", "No active routing rule set is configured.", {
        availableActions: ["create_rule_set"],
      });
    }
    if (expectedVersion != null && expectedVersion !== current.version) {
      throw new TaskLifecycleError(409, "conflict", "Requested routing rule set version is stale.", {
        ruleSetVersion: expectedVersion,
        currentRuleSetVersion: current.version,
        availableActions: ["retry"],
      });
    }
    return current;
  }

  private routeSnapshot(snapshot: ProviderIssueSnapshot, ruleSet: RoutingRuleSet): {
    decision: RoutingDecision;
    inputDigest: string;
  } {
    const inputDigest = sha256(snapshot);
    const matchingRules = this.findMatchingRules(snapshot, ruleSet.rules);
    const topPriority = matchingRules[0]?.priority ?? null;
    const topMatches = topPriority == null ? [] : matchingRules.filter(rule => rule.priority === topPriority);
    const topTargets = [...new Set(topMatches.map(rule => `${rule.target.type}:${rule.target.id}`))];

    if (topMatches.length > 0 && topTargets.length === 1) {
      const winner = topMatches[0]!;
      return {
        decision: this.buildDecision({
          outcome: winner.target.type === "triage_queue" ? "triage" : "assigned",
          target: winner.target,
          assignmentSource: "deterministic_rule",
          confidence: winner.confidence,
          matchedRules: topMatches,
          summary: winner.explanation,
          conflictReasons: [],
        }),
        inputDigest,
      };
    }

    if (topMatches.length > 0 && topTargets.length > 1) {
      return {
        decision: this.buildDecision({
          outcome: "conflict",
          target: { type: "triage_queue", id: ruleSet.classifier.fallbackTriageQueueId },
          assignmentSource: "manual_triage",
          confidence: Math.max(...topMatches.map(rule => rule.confidence)),
          matchedRules: topMatches,
          summary: `Multiple deterministic routing rules matched at priority ${topPriority}.`,
          conflictReasons: [`multiple_targets_at_priority_${topPriority}`],
        }),
        inputDigest,
      };
    }

    const providerMapping = this.resolveProviderAssigneeMapping(snapshot);
    if (providerMapping.kind === "assigned") {
      return {
        decision: this.buildDecision({
          outcome: "assigned",
          target: { type: "agent", id: providerMapping.agentId },
          assignmentSource: "provider_assignee_mapping",
          confidence: 0.9,
          matchedRules: [],
          summary: `Provider assignee mapping matched ${providerMapping.subject} to ${providerMapping.agentId}.`,
          conflictReasons: [],
        }),
        inputDigest,
      };
    }

    if (providerMapping.kind === "conflict") {
      return {
        decision: this.buildDecision({
          outcome: "conflict",
          target: { type: "triage_queue", id: ruleSet.classifier.fallbackTriageQueueId },
          assignmentSource: "manual_triage",
          confidence: 0,
          matchedRules: [],
          summary: "Provider assignee mapping was ambiguous and requires triage.",
          conflictReasons: ["provider_assignee_mapping_conflict"],
        }),
        inputDigest,
      };
    }

    const assignmentSource: TaskAssignmentSource = ruleSet.classifier.enabled ? "classifier" : "manual_triage";
    const summary = ruleSet.classifier.enabled
      ? `No deterministic route matched; classifier fallback is not implemented, so the task was sent to triage ${ruleSet.classifier.fallbackTriageQueueId}.`
      : `No deterministic route matched; the task was sent to triage ${ruleSet.classifier.fallbackTriageQueueId}.`;

    return {
      decision: this.buildDecision({
        outcome: "no_route",
        target: { type: "triage_queue", id: ruleSet.classifier.fallbackTriageQueueId },
        assignmentSource,
        confidence: 0,
        matchedRules: [],
        summary,
        conflictReasons: ["no_matching_rule"],
      }),
      inputDigest,
    };
  }

  private findMatchingRules(snapshot: ProviderIssueSnapshot, rules: RoutingRule[]): RoutingRule[] {
    const eligible: RoutingRule[] = [];
    const repo = repoKey(snapshot);

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!this.ruleMatchesSnapshot(rule, snapshot)) continue;
      if (rule.target.type === "agent") {
        const profile = this.profiles.get(rule.target.id);
        if (!profile || profile.status !== "active") {
          continue;
        }
        if (profile.repoAllowlist.length > 0 && !profile.repoAllowlist.some(candidate => lower(candidate) === lower(repo))) {
          continue;
        }
      }
      eligible.push(rule);
    }

    eligible.sort((left, right) => right.priority - left.priority || right.confidence - left.confidence || left.id.localeCompare(right.id));
    return eligible;
  }

  private ruleMatchesSnapshot(rule: RoutingRule, snapshot: ProviderIssueSnapshot): boolean {
    const conditions = rule.conditions ?? {};
    const repo = repoKey(snapshot);

    if (conditions.repositories?.length && !conditions.repositories.some(candidate => lower(candidate) === lower(repo))) {
      return false;
    }
    if (conditions.labelsAny?.length && !matchesAny(conditions.labelsAny, snapshot.labels)) {
      return false;
    }
    if (conditions.providerAssigneesAny?.length && !matchesAny(conditions.providerAssigneesAny, snapshot.providerAssignees)) {
      return false;
    }
    if (conditions.projects?.length) {
      const project = snapshot.project ?? "";
      if (!conditions.projects.some(candidate => lower(candidate) === lower(project))) {
        return false;
      }
    }
    if (conditions.issueTypes?.length && !conditions.issueTypes.some(candidate => lower(candidate) === lower(snapshot.issueType))) {
      return false;
    }
    if (conditions.priorities?.length && !conditions.priorities.some(candidate => lower(candidate) === lower(snapshot.priority))) {
      return false;
    }
    if (conditions.ownershipTagsAny?.length && !matchesAny(conditions.ownershipTagsAny, snapshot.ownershipTags)) {
      return false;
    }
    if (conditions.capabilityTagsAll?.length && !matchesAll(conditions.capabilityTagsAll, snapshot.capabilityTags)) {
      return false;
    }
    return true;
  }

  private resolveProviderAssigneeMapping(snapshot: ProviderIssueSnapshot):
    | { kind: "none" }
    | { kind: "assigned"; agentId: string; subject: string }
    | { kind: "conflict" } {
    const repo = repoKey(snapshot);
    const matches = new Map<string, string>();

    for (const profile of this.profiles.values()) {
      if (profile.status !== "active") continue;
      if (profile.repoAllowlist.length > 0 && !profile.repoAllowlist.some(candidate => lower(candidate) === lower(repo))) {
        continue;
      }
      for (const mapping of profile.providerIdentityMappings) {
        if (lower(mapping.provider) !== lower(snapshot.provider)) continue;
        const matchedSubject = snapshot.providerAssignees.find(subject => lower(subject) === lower(mapping.subject));
        if (matchedSubject) {
          matches.set(profile.agentId, matchedSubject);
        }
      }
    }

    if (matches.size === 1) {
      const [agentId, subject] = [...matches.entries()][0]!;
      return { kind: "assigned", agentId, subject };
    }
    if (matches.size > 1) {
      return { kind: "conflict" };
    }
    return { kind: "none" };
  }

  private buildDecision({
    outcome,
    target,
    assignmentSource,
    confidence,
    matchedRules,
    summary,
    conflictReasons,
  }: {
    outcome: RoutingDecision["outcome"];
    target: RoutingTarget;
    assignmentSource: TaskAssignmentSource;
    confidence: number;
    matchedRules: RoutingRule[];
    summary: string;
    conflictReasons: string[];
  }): RoutingDecision {
    const id = createId("rdec");
    return {
      id,
      taskId: null,
      taskIdentifier: null,
      outcome,
      target: clone(target),
      assignment: {
        assigneeAgentId: target.type === "agent" ? target.id : null,
        triageQueueId: target.type === "triage_queue" ? target.id : null,
        assignmentSource,
        routingDecisionId: id,
        assignedAt: this.now().toISOString(),
      },
      confidence,
      routingReason: {
        summary,
        matchedRules: matchedRules.map(rule => ({
          id: rule.id,
          name: rule.name,
          confidence: rule.confidence,
        })),
        classifier: null,
        conflictReasons: clone(conflictReasons),
      },
      availableActions: ["view_task", "view_audit"],
    };
  }

  private applyDecisionToTask(snapshot: ProviderIssueSnapshot, decision: RoutingDecision) {
    const existing = this.taskQueue.findTaskByIdentifier(snapshot.providerIssueId);
    const assigneeAgentId = decision.assignment.assigneeAgentId;
    const triageQueueId = decision.assignment.triageQueueId;
    const displayName = assigneeAgentId
      ? this.profiles.get(assigneeAgentId)?.displayName ?? assigneeAgentId
      : `Triage ${triageQueueId}`;
    const commonFields = {
      title: snapshot.title,
      description: `Provider snapshot ${snapshot.providerIssueId}\nBody digest: ${snapshot.bodyDigest}`,
      status: "todo" as const,
      priority: snapshot.priority,
      assignee: { id: assigneeAgentId ?? triageQueueId ?? "triage", name: displayName },
      assigneeAgentId,
      triageQueueId,
      assignmentSource: decision.assignment.assignmentSource,
      routingDecisionId: decision.id,
      routingReason: clone(decision.routingReason),
      routingConfidence: decision.confidence,
      links: { issue: snapshot.links.providerIssue },
      context: {
        project: snapshot.project ?? repoKey(snapshot),
        goal: `Provider issue intake: ${snapshot.providerIssueId}`,
      },
      availableActions: assigneeAgentId ? ["start"] : [],
      source: {
        provider: snapshot.provider,
        owner: snapshot.repository.owner,
        repo: snapshot.repository.name,
        issueNumber: this.extractIssueNumber(snapshot.providerIssueId),
        labels: clone(snapshot.labels),
        assignees: clone(snapshot.providerAssignees),
        deliveryId: snapshot.sourceVersion,
        receivedAt: this.now().toISOString(),
      },
    };

    if (existing) {
      const updated = this.taskQueue.updateTask(existing.id, commonFields);
      if (!updated) {
        throw new TaskLifecycleError(500, "internal_error", "Failed to update routed task assignment.", {
          availableActions: ["retry"],
        });
      }
      return updated;
    }

    return this.taskQueue.createTask({
      identifier: snapshot.providerIssueId,
      acceptanceCriteria: [],
      createdAt: this.now().toISOString(),
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
  }

  private extractIssueNumber(providerIssueId: string): number | undefined {
    const match = providerIssueId.match(/(?:issues\/|issue:)(\d+)$/i);
    return match ? Number.parseInt(match[1]!, 10) : undefined;
  }

  private validateSnapshot(snapshot: ProviderIssueSnapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!snapshot.providerIssueId || !snapshot.title || !snapshot.sourceVersion) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot is missing required fields.", {
        availableActions: ["retry"],
      });
    }
  }

  private validateRuleSetPayload(payload: RoutingRuleSetReplaceRequest) {
    if (!payload || typeof payload !== "object") {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!Array.isArray(payload.rules) || payload.rules.length === 0) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must contain at least one rule.", {
        availableActions: ["retry"],
      });
    }
  }

  private validateAgentProfilePayload(agentId: string, payload: AgentProfileReplaceRequest) {
    if (!agentId.startsWith("agt_")) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `agentId` must start with `agt_`.", {
        availableActions: ["retry"],
      });
    }
    if (!payload || typeof payload !== "object") {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile payload must be an object.", {
        availableActions: ["retry"],
      });
    }
  }
}

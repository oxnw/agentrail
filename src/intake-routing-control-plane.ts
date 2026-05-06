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
  routingAuditStore?: {
    getRoutingAudit(decisionId: string): RoutingAuditRecord | null;
    recordAudit(audit: RoutingAuditRecord): void;
    getIdempotencyEntry<T = unknown>(key: string): IdempotencyEntry<T> | null;
    setIdempotencyEntry<T = unknown>(key: string, entry: IdempotencyEntry<T>): void;
  };
  agentProfileStore?: {
    getAgentProfile(agentId: string): AgentProfile | null;
    listProfiles(): AgentProfile[];
    replaceAgentProfile(
      agentId: string,
      payload: AgentProfileReplaceRequest,
      updatedBy: string,
      idempotencyKey?: string
    ): AgentProfile;
  };
  routingRuleStore?: {
    getCurrentRuleSet(): RoutingRuleSet | null;
    replaceRuleSet(payload: RoutingRuleSetReplaceRequest, createdBy: string, idempotencyKey?: string): RoutingRuleSet;
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

const ROUTING_CONDITION_FIELDS = [
  "repositories",
  "labelsAny",
  "providerAssigneesAny",
  "projects",
  "issueTypes",
  "priorities",
  "ownershipTagsAny",
  "capabilityTagsAll",
] as const;

const ROUTING_CONDITION_FIELD_SET = new Set<string>(ROUTING_CONDITION_FIELDS);
const ROUTING_PROVIDERS = new Set(["github", "linear", "jira", "gitlab"]);
const ROUTING_REPOSITORY_PROVIDERS = new Set(["github", "gitlab"]);
const ROUTING_ISSUE_TYPES = new Set(["bug", "feature", "architecture", "design", "documentation", "maintenance", "unknown"]);
const ROUTING_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const SNAPSHOT_FIELDS = new Set([
  "provider",
  "providerIssueId",
  "sourceVersion",
  "repository",
  "title",
  "bodyDigest",
  "labels",
  "providerAssignees",
  "project",
  "issueType",
  "priority",
  "ownershipTags",
  "capabilityTags",
  "links",
]);
const REPOSITORY_FIELDS = new Set(["provider", "owner", "name", "defaultBranch"]);
const LINKS_FIELDS = new Set(["providerIssue"]);
const RULE_SET_FIELDS = new Set(["sourceRef", "changeReason", "rules", "classifier"]);
const CLASSIFIER_FIELDS = new Set(["enabled", "provider", "confidenceThreshold", "maxCandidates", "fallbackTriageQueueId"]);
const ROUTING_RULE_FIELDS = new Set(["id", "name", "enabled", "priority", "conditions", "target", "confidence", "explanation"]);
const ROUTING_TARGET_FIELDS = new Set(["type", "id"]);
const AGENT_PROFILE_FIELDS = new Set([
  "displayName",
  "role",
  "status",
  "capabilityTags",
  "ownershipTags",
  "repoAllowlist",
  "providerIdentityMappings",
  "maxConcurrentTasks",
  "sourceRef",
  "changeReason",
]);
const PROVIDER_IDENTITY_MAPPING_FIELDS = new Set(["provider", "subject"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export class RoutingControlPlane {
  private readonly now: () => Date;
  private readonly taskQueue: AgentTaskQueue;
  private readonly routingAuditStore: RoutingControlPlaneOptions["routingAuditStore"];
  private readonly agentProfileStore: RoutingControlPlaneOptions["agentProfileStore"];
  private readonly routingRuleStore: RoutingControlPlaneOptions["routingRuleStore"];
  private readonly profiles: Map<string, AgentProfile>;
  private readonly audits: Map<string, RoutingAuditRecord>;
  private readonly idempotency: Map<string, IdempotencyEntry<unknown>>;
  private ruleSets: RoutingRuleSet[];

  constructor({ now = () => new Date(), taskQueue, routingAuditStore, agentProfileStore, routingRuleStore }: RoutingControlPlaneOptions) {
    this.now = now;
    this.taskQueue = taskQueue;
    this.routingAuditStore = routingAuditStore;
    this.agentProfileStore = agentProfileStore;
    this.routingRuleStore = routingRuleStore;
    this.profiles = new Map();
    this.audits = new Map();
    this.idempotency = new Map();
    this.ruleSets = [];
  }

  getCurrentRuleSet(): RoutingRuleSet | null {
    if (this.routingRuleStore) {
      return this.routingRuleStore.getCurrentRuleSet();
    }
    return this.ruleSets.length > 0 ? clone(this.ruleSets[this.ruleSets.length - 1]!) : null;
  }

  replaceRuleSet(payload: RoutingRuleSetReplaceRequest, createdBy: string, idempotencyKey?: string): RoutingRuleSet {
    this.validateRuleSetPayload(payload);
    if (this.routingRuleStore) {
      return this.routingRuleStore.replaceRuleSet(payload, createdBy, idempotencyKey);
    }

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
    if (this.agentProfileStore) {
      return this.agentProfileStore.getAgentProfile(agentId);
    }
    return this.profiles.has(agentId) ? clone(this.profiles.get(agentId)!) : null;
  }

  replaceAgentProfile(agentId: string, payload: AgentProfileReplaceRequest, updatedBy: string, idempotencyKey?: string): AgentProfile {
    this.validateAgentProfilePayload(agentId, payload);
    if (this.agentProfileStore) {
      return this.agentProfileStore.replaceAgentProfile(agentId, payload, updatedBy, idempotencyKey);
    }

    const fingerprint = sha256({ agentId, payload });

    if (idempotencyKey) {
      const entry = this.idempotency.get(`agent-profile:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different routing agent profile payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response as AgentProfile);
      }
    }

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

    if (idempotencyKey) {
      this.idempotency.set(`agent-profile:${idempotencyKey}`, {
        fingerprint,
        response: clone(profile),
      });
    }

    return clone(profile);
  }

  async evaluate(request: RoutingEvaluationRequest, idempotencyKey?: string): Promise<RoutingDecision> {
    if (!isRecord(request)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing evaluation payload must be an object.", {
        availableActions: ["retry"],
      });
    }
    const { ruleSetVersion, snapshot } = request as RoutingEvaluationRequest;
    this.validateSnapshot(snapshot);
    const fingerprint = sha256({
      ruleSetVersion: ruleSetVersion ?? null,
      snapshot,
    });

    if (idempotencyKey) {
      const entry = this.getRoutingIdempotencyEntry<RoutingDecision>(`evaluation:${idempotencyKey}`);
      if (entry) {
        if (entry.fingerprint !== fingerprint) {
          throw new TaskLifecycleError(409, "conflict", "Idempotency-Key has already been used with a different routing evaluation payload.", {
            idempotencyKey,
            availableActions: ["retry"],
          });
        }
        return clone(entry.response as RoutingDecision);
      }
    }

    const ruleSet = this.resolveCurrentRuleSet(ruleSetVersion);
    const { decision, inputDigest } = this.routeSnapshot(snapshot, ruleSet);
    decision.assignment.assignedAt = null;
    decision.availableActions = ["view_audit"];
    this.recordAudit(decision, inputDigest, ruleSet);

    if (idempotencyKey) {
      this.setRoutingIdempotencyEntry(`evaluation:${idempotencyKey}`, {
        fingerprint,
        response: clone(decision),
      });
    }

    return clone(decision);
  }

  async ingestProviderIssue(snapshot: ProviderIssueSnapshot, idempotencyKey?: string): Promise<RoutingDecision> {
    this.validateSnapshot(snapshot);
    const fingerprint = sha256(snapshot);

    if (idempotencyKey) {
      const entry = this.getRoutingIdempotencyEntry<RoutingDecision>(`intake:${idempotencyKey}`);
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

    this.recordAudit(decision, inputDigest, ruleSet);

    if (idempotencyKey) {
      this.setRoutingIdempotencyEntry(`intake:${idempotencyKey}`, {
        fingerprint,
        response: clone(decision),
      });
    }

    return clone(decision);
  }

  getRoutingAudit(decisionId: string): RoutingAuditRecord | null {
    if (this.routingAuditStore) {
      return this.routingAuditStore.getRoutingAudit(decisionId);
    }
    return this.audits.has(decisionId) ? clone(this.audits.get(decisionId)!) : null;
  }

  private getRoutingIdempotencyEntry<T>(key: string): IdempotencyEntry<T> | null {
    if (this.routingAuditStore) {
      return this.routingAuditStore.getIdempotencyEntry<T>(key);
    }
    const entry = this.idempotency.get(key) ?? null;
    return entry ? clone(entry as IdempotencyEntry<T>) : null;
  }

  private setRoutingIdempotencyEntry<T>(key: string, entry: IdempotencyEntry<T>): void {
    if (this.routingAuditStore) {
      this.routingAuditStore.setIdempotencyEntry(key, clone(entry));
      return;
    }
    this.idempotency.set(key, clone(entry as IdempotencyEntry<unknown>));
  }

  private recordAudit(decision: RoutingDecision, inputDigest: string, ruleSet: RoutingRuleSet) {
    const audit: RoutingAuditRecord = {
      decision: clone(decision),
      inputDigest,
      ruleSet: {
        id: ruleSet.id,
        version: ruleSet.version,
      },
      createdAt: this.now().toISOString(),
    };
    if (this.routingAuditStore) {
      this.routingAuditStore.recordAudit(audit);
      return;
    }
    this.audits.set(decision.id, audit);
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

    const assignmentSource: TaskAssignmentSource = "manual_triage";
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
        const profile = this.getAgentProfile(rule.target.id);
        if (!profile || !this.isAgentEligibleForSnapshot(profile, repo, snapshot.providerIssueId)) {
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

    for (const profile of this.listAgentProfiles()) {
      if (!this.isAgentEligibleForSnapshot(profile, repo, snapshot.providerIssueId)) continue;
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
    const routeAvailableActions = assigneeAgentId ? ["start"] : [];
    const displayName = assigneeAgentId
      ? this.getAgentProfile(assigneeAgentId)?.displayName ?? assigneeAgentId
      : `Triage ${triageQueueId}`;
    const commonFields = {
      title: snapshot.title,
      description: `Provider snapshot ${snapshot.providerIssueId}\nBody digest: ${snapshot.bodyDigest}`,
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
      source: {
        provider: snapshot.repository.provider,
        owner: snapshot.repository.owner,
        repo: snapshot.repository.name,
        baseBranch: snapshot.repository.defaultBranch,
        issueNumber: this.extractIssueNumber(snapshot.providerIssueId),
        labels: clone(snapshot.labels),
        assignees: clone(snapshot.providerAssignees),
        deliveryId: snapshot.sourceVersion,
        receivedAt: this.now().toISOString(),
      },
    };

    if (existing) {
      const updated = this.taskQueue.updateTask(existing.id, {
        ...commonFields,
        ...(existing.status === "todo" ? { availableActions: routeAvailableActions } : {}),
      });
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
      status: "todo",
      availableActions: routeAvailableActions,
      ...commonFields,
    });
  }

  private isAgentEligibleForSnapshot(profile: AgentProfile, repo: string, providerIssueId: string): boolean {
    if (profile.status !== "active") {
      return false;
    }
    if (!Array.isArray(profile.repoAllowlist) || !Array.isArray(profile.providerIdentityMappings)) {
      return false;
    }
    if (profile.repoAllowlist.length > 0 && !profile.repoAllowlist.some(candidate => lower(candidate) === lower(repo))) {
      return false;
    }
    return this.hasAgentCapacity(profile, providerIssueId);
  }

  private hasAgentCapacity(profile: AgentProfile, providerIssueId: string): boolean {
    if (!Number.isInteger(profile.maxConcurrentTasks) || profile.maxConcurrentTasks <= 0) {
      return false;
    }

    const existing = this.taskQueue.findTaskByIdentifier(providerIssueId);
    let activeAssignedCount = 0;
    for (const status of ["todo", "in_progress", "in_review", "blocked"]) {
      let cursor: string | null = null;
      do {
        const assignedTasks = this.taskQueue.listMyTasks({
          assigneeAgentId: profile.agentId,
          status,
          limit: 100,
          cursor,
        });
        activeAssignedCount += assignedTasks.data.filter(task => task.id !== existing?.id).length;
        if (activeAssignedCount >= profile.maxConcurrentTasks) {
          return false;
        }
        cursor = assignedTasks.page.nextCursor;
      } while (cursor);
    }

    return true;
  }

  private extractIssueNumber(providerIssueId: string): number | undefined {
    const match = providerIssueId.match(/(?:issues\/|issue:)(\d+)$/i);
    return match ? Number.parseInt(match[1]!, 10) : undefined;
  }

  private listAgentProfiles(): AgentProfile[] {
    if (this.agentProfileStore) {
      return this.agentProfileStore.listProfiles();
    }
    return [...this.profiles.values()].map(clone);
  }

  private validateSnapshot(snapshot: ProviderIssueSnapshot) {
    if (!isRecord(snapshot)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!hasOnlyKeys(snapshot, SNAPSHOT_FIELDS)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot contains unsupported fields.", {
        availableActions: ["retry"],
      });
    }
    if (
      !isNonEmptyString(snapshot.provider) ||
      !isNonEmptyString(snapshot.providerIssueId) ||
      !isNonEmptyString(snapshot.sourceVersion) ||
      !isNonEmptyString(snapshot.title) ||
      snapshot.title.length > 240 ||
      !isNonEmptyString(snapshot.bodyDigest) ||
      !isNonEmptyString(snapshot.issueType) ||
      !isNonEmptyString(snapshot.priority)
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot is missing required fields.", {
        availableActions: ["retry"],
      });
    }
    if (!ROUTING_PROVIDERS.has(snapshot.provider)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot contains an unsupported provider.", {
        availableActions: ["retry"],
      });
    }
    if (!ROUTING_ISSUE_TYPES.has(snapshot.issueType)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot contains an unsupported issueType.", {
        availableActions: ["retry"],
      });
    }
    if (!ROUTING_PRIORITIES.has(snapshot.priority)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot contains an unsupported priority.", {
        availableActions: ["retry"],
      });
    }
    if (
      !isRecord(snapshot.repository) ||
      !hasOnlyKeys(snapshot.repository, REPOSITORY_FIELDS) ||
      !isNonEmptyString(snapshot.repository.provider) ||
      !isNonEmptyString(snapshot.repository.owner) ||
      !isNonEmptyString(snapshot.repository.name) ||
      !isNonEmptyString(snapshot.repository.defaultBranch)
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot is missing required repository fields.", {
        availableActions: ["retry"],
      });
    }
    if (!ROUTING_REPOSITORY_PROVIDERS.has(snapshot.repository.provider)) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot contains an unsupported repository provider.", {
        availableActions: ["retry"],
      });
    }
    const arrayLimits = {
      labels: 50,
      providerAssignees: 20,
      ownershipTags: 20,
      capabilityTags: 20,
    } as const;
    for (const field of Object.keys(arrayLimits) as Array<keyof typeof arrayLimits>) {
      if (!isStringArray(snapshot[field]) || snapshot[field].length > arrayLimits[field]) {
        throw new TaskLifecycleError(400, "validation_error", `Provider issue snapshot \`${field}\` must be an array of strings.`, {
          availableActions: ["retry"],
        });
      }
    }
    if (snapshot.project !== undefined && snapshot.project !== null && typeof snapshot.project !== "string") {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot `project` must be a string or null.", {
        availableActions: ["retry"],
      });
    }
    if (
      !isRecord(snapshot.links) ||
      !hasOnlyKeys(snapshot.links, LINKS_FIELDS) ||
      !isNonEmptyString(snapshot.links.providerIssue) ||
      !isUrl(snapshot.links.providerIssue)
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Provider issue snapshot is missing required links.providerIssue.", {
        availableActions: ["retry"],
      });
    }
  }

  private validateRuleSetPayload(payload: RoutingRuleSetReplaceRequest) {
    if (!isRecord(payload)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!hasOnlyKeys(payload, RULE_SET_FIELDS)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload contains unsupported fields.", {
        availableActions: ["retry"],
      });
    }
    if (!isNonEmptyString(payload.sourceRef) || !isNonEmptyString(payload.changeReason) || payload.changeReason.length > 500) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload is missing required source metadata.", {
        availableActions: ["retry"],
      });
    }
    if (!Array.isArray(payload.rules) || payload.rules.length === 0) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must contain at least one rule.", {
        availableActions: ["retry"],
      });
    }
    if (payload.rules.length > 200) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload cannot contain more than 200 rules.", {
        availableActions: ["retry"],
      });
    }
    payload.rules.forEach((rule, index) => this.validateRoutingRulePayload(rule, index));
    if (
      !isRecord(payload.classifier) ||
      !hasOnlyKeys(payload.classifier, CLASSIFIER_FIELDS) ||
      typeof payload.classifier.enabled !== "boolean" ||
      !isNonEmptyString(payload.classifier.provider) ||
      typeof payload.classifier.confidenceThreshold !== "number" ||
      payload.classifier.confidenceThreshold < 0 ||
      payload.classifier.confidenceThreshold > 1 ||
      !Number.isInteger(payload.classifier.maxCandidates) ||
      payload.classifier.maxCandidates < 1 ||
      payload.classifier.maxCandidates > 10 ||
      !isNonEmptyString(payload.classifier.fallbackTriageQueueId)
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing rule set payload must include a valid classifier config.", {
        availableActions: ["retry"],
      });
    }
  }

  private validateRoutingRulePayload(rule: unknown, index: number) {
    const invalid = (reason: string): never => {
      throw new TaskLifecycleError(400, "validation_error", `Routing rule set payload contains an invalid rule at index ${index}: ${reason}.`, {
        availableActions: ["retry"],
      });
    };

    if (!isRecord(rule)) {
      invalid("rule must be an object");
    }
    const candidate = rule as Record<string, unknown>;
    if (!hasOnlyKeys(candidate, ROUTING_RULE_FIELDS)) {
      invalid("rule contains unsupported fields");
    }
    if (!isNonEmptyString(candidate.id)) {
      invalid("id is required");
    }
    if (!isNonEmptyString(candidate.name)) {
      invalid("name is required");
    }
    if (typeof candidate.enabled !== "boolean") {
      invalid("enabled must be a boolean");
    }
    if (!Number.isInteger(candidate.priority)) {
      invalid("priority must be an integer");
    }
    if (!isRecord(candidate.conditions)) {
      invalid("conditions must be an object");
    }
    const conditions = candidate.conditions as Record<string, unknown>;
    this.validateRoutingConditions(conditions, invalid);
    if (!isRecord(candidate.target)) {
      invalid("target must be an object");
    }
    const target = candidate.target as Record<string, unknown>;
    if (!hasOnlyKeys(target, ROUTING_TARGET_FIELDS)) {
      invalid("target contains unsupported fields");
    }
    const targetType = target.type;
    const targetId = target.id;
    if (!["agent", "triage_queue"].includes(String(targetType))) {
      invalid("target.type must be agent or triage_queue");
    }
    if (!isNonEmptyString(targetId)) {
      invalid("target.id is required");
    }
    const targetIdString = targetId as string;
    if (targetType === "agent" && !targetIdString.startsWith("agt_")) {
      invalid("agent target.id must start with `agt_`");
    }
    if (
      typeof candidate.confidence !== "number" ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      invalid("confidence must be between 0 and 1");
    }
    if (!isNonEmptyString(candidate.explanation) || candidate.explanation.length > 300) {
      invalid("explanation is required and must be 300 characters or less");
    }
  }

  private validateRoutingConditions(conditions: Record<string, unknown>, invalid: (reason: string) => never) {
    for (const key of Object.keys(conditions)) {
      if (!ROUTING_CONDITION_FIELD_SET.has(key)) {
        invalid(`conditions.${key} is not supported`);
      }
    }
    for (const key of ROUTING_CONDITION_FIELDS) {
      const value = conditions[key];
      if (value === undefined) {
        continue;
      }
      if (!isStringArray(value)) {
        invalid(`conditions.${key} must be an array of strings`);
      }
    }
    if (conditions.issueTypes !== undefined && !(conditions.issueTypes as string[]).every(issueType => ROUTING_ISSUE_TYPES.has(issueType))) {
      invalid("conditions.issueTypes contains an unsupported issue type");
    }
    if (conditions.priorities !== undefined && !(conditions.priorities as string[]).every(priority => ROUTING_PRIORITIES.has(priority))) {
      invalid("conditions.priorities contains an unsupported priority");
    }
  }

  private validateAgentProfilePayload(agentId: string, payload: AgentProfileReplaceRequest) {
    if (!agentId.startsWith("agt_")) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `agentId` must start with `agt_`.", {
        availableActions: ["retry"],
      });
    }
    if (!isRecord(payload)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile payload must be an object.", {
        availableActions: ["retry"],
      });
    }
    if (!hasOnlyKeys(payload, AGENT_PROFILE_FIELDS)) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile contains unsupported fields.", {
        availableActions: ["retry"],
      });
    }
    if (
      !isNonEmptyString(payload.displayName) ||
      !isNonEmptyString(payload.role) ||
      !["active", "paused", "disabled"].includes(payload.status) ||
      !Number.isInteger(payload.maxConcurrentTasks) ||
      payload.maxConcurrentTasks < 0 ||
      payload.maxConcurrentTasks > 50 ||
      !isNonEmptyString(payload.sourceRef) ||
      !isNonEmptyString(payload.changeReason) ||
      payload.changeReason.length > 500
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile is missing required scalar fields.", {
        availableActions: ["retry"],
      });
    }
    const arrayLimits = {
      capabilityTags: 50,
      ownershipTags: 50,
      repoAllowlist: 200,
    } as const;
    for (const field of Object.keys(arrayLimits) as Array<keyof typeof arrayLimits>) {
      if (!isStringArray(payload[field]) || payload[field].length > arrayLimits[field]) {
        throw new TaskLifecycleError(400, "validation_error", `Routing agent profile \`${field}\` must be an array of strings.`, {
          availableActions: ["retry"],
        });
      }
    }
    if (
      !Array.isArray(payload.providerIdentityMappings) ||
      payload.providerIdentityMappings.length > 20 ||
      !payload.providerIdentityMappings.every(mapping =>
        isRecord(mapping) &&
        hasOnlyKeys(mapping, PROVIDER_IDENTITY_MAPPING_FIELDS) &&
        isNonEmptyString(mapping.provider) &&
        ROUTING_PROVIDERS.has(mapping.provider) &&
        isNonEmptyString(mapping.subject)
      )
    ) {
      throw new TaskLifecycleError(400, "validation_error", "Routing agent profile `providerIdentityMappings` must contain provider/subject mappings.", {
        availableActions: ["retry"],
      });
    }
  }
}

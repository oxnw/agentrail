import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import {
  RoutingControlPlane,
  type AgentProfileReplaceRequest,
  type ProviderIssueSnapshot,
  type RoutingRule,
} from "../src/intake-routing-control-plane.ts";
import type { RoutingClassifier, RoutingClassifierOutput } from "../src/routing-classifier.ts";
import { RoutingAuditStore } from "../src/routing-audit-store.ts";
import { RoutingRuleStore } from "../src/routing-rule-store.ts";
import { TaskLifecycleError } from "../src/task-lifecycle-errors.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const FIXED_NOW = new Date("2026-05-05T12:00:00Z");
const now = () => FIXED_NOW;

function createControlPlane(classifier: RoutingClassifier | null = null) {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routing = new RoutingControlPlane({ now, taskQueue, classifier });
  return { routing, taskQueue };
}

function makeSnapshot(overrides: Partial<ProviderIssueSnapshot> = {}): ProviderIssueSnapshot {
  return {
    provider: "github",
    providerIssueId: "github:oxnw/agentrail:issues/99",
    sourceVersion: "2026-05-05T12:00:00Z:delivery-01",
    repository: {
      provider: "github",
      owner: "oxnw",
      name: "agentrail",
      defaultBranch: "main",
    },
    title: "Define routing behavior",
    bodyDigest: "sha256:test",
    labels: ["architecture", "api"],
    project: "Documentation",
    issueType: "architecture",
    priority: "high",
    ownershipTags: ["control-plane"],
    capabilityTags: ["api-design", "architecture"],
    links: {
      providerIssue: "https://github.com/oxnw/agentrail/issues/99",
    },
    ...overrides,
  };
}

function seedProfile(
  routing: RoutingControlPlane,
  agentId: string,
  overrides: Partial<AgentProfileReplaceRequest> = {}
) {
  routing.replaceAgentProfile(agentId, {
    displayName: agentId,
    role: "engineer",
    status: "active",
    capabilityTags: ["api-design", "architecture"],
    ownershipTags: ["control-plane"],
    repoAllowlist: ["oxnw/agentrail"],
    maxConcurrentTasks: 5,
    sourceRef: "AGEA-99",
    changeReason: "seed profile for routing tests",
    ...overrides,
  }, "agt_router");
}

function seedRuleSet(routing: RoutingControlPlane, rules: RoutingRule[]) {
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "seed rule set for routing tests",
    rules,
    classifier: {
      enabled: false,
      provider: "internal-router",
      confidenceThreshold: 0.82,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_router");
}

async function withTempAuditStore<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-routing-audit-"));
  const storagePath = path.join(tempDir, "routing-audit.json");

  try {
    return await fn(storagePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("RoutingControlPlane deterministically assigns and persists routing metadata", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: {
        repositories: ["oxnw/agentrail"],
        labelsAny: ["architecture", "api"],
        issueTypes: ["architecture"],
        capabilityTagsAll: ["api-design"],
      },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Repo and architecture labels map to CTO ownership.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_01");
  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assigneeAgentId, "agt_cto");
  assert.equal(decision.assignment.assignmentSource, "deterministic_rule");
  assert.equal(decision.routingReason.matchedRules[0]?.id, "rule_architecture_to_cto");
  assert.ok(decision.taskId);

  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.ok(stored);
  assert.equal(stored?.assigneeAgentId, "agt_cto");
  assert.equal(stored?.assignmentSource, "deterministic_rule");
  assert.equal(stored?.routingDecisionId, decision.id);
  assert.equal(stored?.routingConfidence, 0.99);
  assert.equal(stored?.routingReason?.matchedRules[0]?.id, "rule_architecture_to_cto");
});

test("RoutingControlPlane preserves provider repository default branch on routed task source", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot({
    repository: {
      provider: "github",
      owner: "oxnw",
      name: "agentrail",
      defaultBranch: "develop",
    },
  }), "route_default_branch");

  assert.ok(decision.taskId);
  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.equal(stored?.source?.baseBranch, "develop");
});

test("RoutingControlPlane stores the repository provider as the task source provider", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot({
    provider: "linear",
    providerIssueId: "linear:AGENT-99",
    links: { providerIssue: "https://linear.app/agentrail/issue/AGENT-99" },
  }), "route_repository_provider");

  assert.ok(decision.taskId);
  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.equal(stored?.source?.provider, "github");
});

test("RoutingControlPlane preserves lifecycle status and actions when re-routing an existing task", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO ownership.",
    },
  ]);

  const firstDecision = await routing.ingestProviderIssue(makeSnapshot(), "route_preserve_first");
  assert.ok(firstDecision.taskId);
  taskQueue.updateTask(firstDecision.taskId!, {
    status: "in_review",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
  });

  await routing.ingestProviderIssue(makeSnapshot({
    sourceVersion: "2026-05-05T12:01:00Z:delivery-02",
    labels: ["architecture", "api", "needs-refresh"],
  }), "route_preserve_second");

  const stored = taskQueue.getRawTask(firstDecision.taskId!);
  assert.equal(stored?.status, "in_review");
  assert.deepEqual(stored?.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(stored?.source?.deliveryId, "2026-05-05T12:01:00Z:delivery-02");
});

test("RoutingRuleStore drops persisted legacy provider-assignee rules instead of broadening them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-routing-rules-"));
  const storagePath = path.join(tempDir, "routing-rules.json");

  await writeFile(storagePath, `${JSON.stringify({
    ruleSets: [{
      id: "rset_legacy",
      version: 1,
      status: "active",
      source: "admin_api",
      sourceRef: "legacy-test",
      createdBy: "agt_router",
      createdAt: FIXED_NOW.toISOString(),
      rules: [
        {
          id: "legacy_provider_rule",
          name: "Legacy provider-assignee rule",
          enabled: true,
          priority: 10,
          conditions: {
            repositories: ["oxnw/agentrail"],
            providerAssigneesAny: ["github:onyeka"],
          },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.95,
          explanation: "Legacy provider mapping",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
      audit: {
        supersedesRuleSetId: null,
        changeReason: "legacy seed",
      },
    }],
    idempotencyEntries: [],
  }, null, 2)}\n`);

  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on("warning", onWarning);
  try {
    const store = new RoutingRuleStore({ now, storagePath });
    const current = store.getCurrentRuleSet();
    assert.ok(current);
    assert.deepEqual(current.rules, []);

    const persisted = JSON.parse(await readFile(storagePath, "utf8"));
    assert.equal(persisted.ruleSets[0].rules[0].id, "legacy_provider_rule");
  } finally {
    process.off("warning", onWarning);
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.match(warnings.join("\n"), /dropped legacy provider-assignee routing rules/i);
  assert.match(warnings.join("\n"), /legacy_provider_rule/);
});

test("RoutingControlPlane resets available actions when re-routing todo tasks between triage and agent", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_bugs_only",
      name: "Bug ownership",
      enabled: true,
      priority: 10,
      conditions: { issueTypes: ["bug"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Bug work maps to CTO.",
    },
  ]);

  const firstDecision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "documentation" }), "route_actions_first");
  assert.ok(firstDecision.taskId);
  assert.deepEqual(taskQueue.getRawTask(firstDecision.taskId!)?.availableActions, []);

  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);
  await routing.ingestProviderIssue(makeSnapshot({
    sourceVersion: "2026-05-05T12:01:00Z:delivery-02",
  }), "route_actions_second");
  const assigned = taskQueue.getRawTask(firstDecision.taskId!);
  assert.equal(assigned?.assigneeAgentId, "agt_cto");
  assert.deepEqual(assigned?.availableActions, ["start"]);

  seedRuleSet(routing, [
    {
      id: "rule_bugs_again",
      name: "Bug ownership again",
      enabled: true,
      priority: 10,
      conditions: { issueTypes: ["bug"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Bug work maps to CTO.",
    },
  ]);
  await routing.ingestProviderIssue(makeSnapshot({
    issueType: "documentation",
    sourceVersion: "2026-05-05T12:02:00Z:delivery-03",
  }), "route_actions_third");
  const triaged = taskQueue.getRawTask(firstDecision.taskId!);
  assert.equal(triaged?.assigneeAgentId, null);
  assert.equal(triaged?.triageQueueId, "triage_engineering");
  assert.deepEqual(triaged?.availableActions, []);
});

test("RoutingControlPlane rejects malformed routing rules before activation", () => {
  const invalidRules: Array<[string, Record<string, unknown>]> = [
    ["missing conditions", {
      id: "rule_missing_conditions",
      name: "Missing conditions",
      enabled: true,
      priority: 10,
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Invalid rule.",
    }],
    ["missing target id", {
      id: "rule_missing_target_id",
      name: "Missing target id",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent" },
      confidence: 0.99,
      explanation: "Invalid rule.",
    }],
    ["invalid target type", {
      id: "rule_invalid_target_type",
      name: "Invalid target type",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "webhook", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Invalid rule.",
    }],
    ["invalid confidence", {
      id: "rule_invalid_confidence",
      name: "Invalid confidence",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 1.01,
      explanation: "Invalid rule.",
    }],
    ["malformed conditions", {
      id: "rule_malformed_conditions",
      name: "Malformed conditions",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: "architecture" },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Invalid rule.",
    }],
  ];

  for (const [caseName, rule] of invalidRules) {
    const { routing } = createControlPlane();
    seedRuleSet(routing, [
      {
        id: "rule_valid",
        name: "Valid routing rule",
        enabled: true,
        priority: 10,
        conditions: { labelsAny: ["architecture"] },
        target: { type: "agent", id: "agt_cto" },
        confidence: 0.99,
        explanation: "Architecture work maps to CTO.",
      },
    ]);

    assert.throws(
      () => routing.replaceRuleSet({
        sourceRef: "AGEA-99",
        changeReason: `attempt invalid rule: ${caseName}`,
        rules: [rule as unknown as RoutingRule],
        classifier: {
          enabled: false,
          provider: "internal-router",
          confidenceThreshold: 0.82,
          maxCandidates: 3,
          fallbackTriageQueueId: "triage_engineering",
        },
      }, "agt_router", `bad_rule_${caseName.replaceAll(" ", "_")}`),
      (error: unknown) =>
        error instanceof TaskLifecycleError &&
        error.statusCode === 400 &&
        /Routing rule set payload contains an invalid rule/i.test(error.message)
    );

    const current = routing.getCurrentRuleSet();
    assert.equal(current?.version, 1);
    assert.equal(current?.rules[0]?.id, "rule_valid");
  }
});

test("RoutingControlPlane still assigns deterministic rules when the target agent is already busy", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto", {
    maxConcurrentTasks: 1,
  });
  taskQueue.createTask({
    identifier: "github:oxnw/agentrail:issues/98",
    title: "Existing assigned task",
    description: "Consumes CTO capacity.",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_cto", name: "CTO" },
    assigneeAgentId: "agt_cto",
    acceptanceCriteria: [],
    links: { issue: "https://github.com/oxnw/agentrail/issues/98" },
    context: { project: "Documentation", goal: "Capacity test" },
    availableActions: ["submit"],
  });
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_capacity");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assigneeAgentId, "agt_cto");
  assert.equal(decision.assignment.assignmentSource, "deterministic_rule");
});

test("RoutingControlPlane ignores setup verification tasks when checking agent capacity", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto", {
    maxConcurrentTasks: 1,
  });
  taskQueue.createTask({
    identifier: "LOCAL-SETUP-AGT-CTO",
    title: "Setup verification",
    description: "Should not consume routing capacity.",
    status: "in_progress",
    priority: "medium",
    assignee: { id: "agt_cto", name: "CTO" },
    assigneeAgentId: "agt_cto",
    acceptanceCriteria: [],
    links: { issue: "agentrail://setup-verification/agt_cto" },
    context: { project: "oxnw/agentrail", goal: "Setup verification" },
    availableActions: ["submit"],
    source: {
      provider: "agentrail_setup",
      owner: "oxnw",
      repo: "agentrail",
    },
  });
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_capacity_setup_task");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assigneeAgentId, "agt_cto");
  assert.ok(decision.taskId);
});

test("RoutingControlPlane still assigns when older active tasks exist and newer tasks are terminal", async () => {
  let tick = 0;
  const now = () => new Date(Date.parse("2026-05-05T12:00:00Z") + tick++ * 1000);
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routing = new RoutingControlPlane({ now, taskQueue });

  seedProfile(routing, "agt_cto", {
    maxConcurrentTasks: 1,
  });
  taskQueue.createTask({
    identifier: "github:oxnw/agentrail:issues/active-old",
    title: "Older active assigned task",
    description: "Consumes CTO capacity but is older than terminal tasks.",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_cto", name: "CTO" },
    assigneeAgentId: "agt_cto",
    acceptanceCriteria: [],
    links: { issue: "https://github.com/oxnw/agentrail/issues/97" },
    context: { project: "Documentation", goal: "Capacity test" },
    availableActions: ["submit"],
  });
  for (let i = 0; i < 101; i++) {
    taskQueue.createTask({
      identifier: `github:oxnw/agentrail:issues/done-${i}`,
      title: `Terminal task ${i}`,
      description: "Does not consume capacity.",
      status: i % 2 === 0 ? "done" : "cancelled",
      priority: "low",
      assignee: { id: "agt_cto", name: "CTO" },
      assigneeAgentId: "agt_cto",
      acceptanceCriteria: [],
      links: { issue: `https://github.com/oxnw/agentrail/issues/${i}` },
      context: { project: "Documentation", goal: "Capacity test" },
      availableActions: [],
    });
  }
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_capacity_many_terminal");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assigneeAgentId, "agt_cto");
  assert.equal(decision.assignment.assignmentSource, "deterministic_rule");
});

test("RoutingControlPlane preserves deterministic assignment when re-routing existing tasks under load", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto", {
    maxConcurrentTasks: 1,
  });
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const firstDecision = await routing.ingestProviderIssue(makeSnapshot(), "route_existing_capacity_first");
  assert.ok(firstDecision.taskId);

  taskQueue.createTask({
    identifier: "github:oxnw/agentrail:issues/occupied-capacity",
    title: "Already active task",
    description: "Consumes the only available CTO slot.",
    status: "todo",
    priority: "medium",
    assignee: { id: "agt_cto", name: "CTO" },
    assigneeAgentId: "agt_cto",
    acceptanceCriteria: [],
    links: { issue: "https://github.com/oxnw/agentrail/issues/occupied-capacity" },
    context: { project: "AgentRail", goal: "Capacity test" },
    availableActions: ["start"],
  });

  const reroutedDecision = await routing.ingestProviderIssue(makeSnapshot({
    sourceVersion: "2026-05-05T12:05:00Z:delivery-02",
  }), "route_existing_capacity_second");

  assert.equal(reroutedDecision.outcome, "assigned");
  assert.equal(reroutedDecision.assignment.assigneeAgentId, "agt_cto");
  assert.equal(reroutedDecision.assignment.assignmentSource, "deterministic_rule");
});

test("RoutingControlPlane sends ambiguous matches to triage", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedProfile(routing, "agt_founding");
  seedRuleSet(routing, [
    {
      id: "rule_api_to_cto",
      name: "API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["api"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.92,
      explanation: "API work maps to CTO.",
    },
    {
      id: "rule_api_to_founding",
      name: "API fallback ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["api"] },
      target: { type: "agent", id: "agt_founding" },
      confidence: 0.91,
      explanation: "API work also maps to Founding Engineer.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_ambiguous");
  assert.equal(decision.outcome, "conflict");
  assert.equal(decision.assignment.assigneeAgentId, null);
  assert.equal(decision.assignment.triageQueueId, "triage_engineering");
  assert.ok(decision.routingReason.conflictReasons.length > 0);
  assert.ok(decision.taskId);

  const detail = taskQueue.getTask(decision.taskId!);
  assert.equal((detail.data as any).assigneeAgentId, null);
  assert.equal((detail.data as any).triageQueueId, "triage_engineering");
});

test("RoutingControlPlane falls back to triage when no deterministic rule matches", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_bugs_only",
      name: "Bug ownership",
      enabled: true,
      priority: 10,
      conditions: { issueTypes: ["bug"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.75,
      explanation: "Bug work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "documentation" }), "route_nomatch");
  assert.equal(decision.outcome, "no_route");
  assert.equal(decision.assignment.assigneeAgentId, null);
  assert.equal(decision.assignment.triageQueueId, "triage_engineering");
  assert.match(decision.routingReason.summary, /No deterministic route/i);
});

test("RoutingControlPlane triages classifier-enabled fallback when no classifier is configured", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto");
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "seed classifier-enabled fallback test",
    rules: [
      {
        id: "rule_bugs_only",
        name: "Bug ownership",
        enabled: true,
        priority: 10,
        conditions: { issueTypes: ["bug"] },
        target: { type: "agent", id: "agt_cto" },
        confidence: 0.99,
        explanation: "Bug work maps to CTO.",
      },
    ],
    classifier: {
      enabled: true,
      provider: "internal-router",
      confidenceThreshold: 0.82,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_router", "idemp_classifier_enabled_fallback");

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "documentation" }), "route_classifier_enabled_no_route");

  assert.equal(decision.outcome, "triage");
  assert.equal(decision.assignment.assignmentSource, "manual_triage");
  assert.equal(decision.routingReason.classifier?.provider, "internal-router");
  assert.deepEqual(decision.routingReason.conflictReasons, ["classifier_unavailable"]);
  assert.ok(decision.taskId);

  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.equal(stored?.assignmentSource, "manual_triage");
});

test("RoutingControlPlane assigns Linear tasks to the sole active agent when no route matches", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_linear");
  seedRuleSet(routing, [
    {
      id: "rule_unrelated_github_only",
      name: "Unrelated GitHub rule",
      enabled: true,
      priority: 5,
      conditions: {
        repositories: ["oxnw/agentrail"],
        labelsAny: ["backend-only"],
      },
      target: { type: "agent", id: "agt_linear" },
      confidence: 0.8,
      explanation: "Unrelated GitHub-only rule.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot({
    provider: "linear",
    providerIssueId: "linear:tsting:issues/TES-5",
    repository: {
      provider: "linear",
      owner: "tsting",
      name: "TES",
      defaultBranch: "main",
    },
    links: { providerIssue: "https://linear.app/tsting/issue/TES-5" },
  }), "route_linear_single_agent_fallback");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assigneeAgentId, "agt_linear");
  assert.equal(decision.assignment.assignmentSource, "single_agent_fallback");
  assert.match(decision.routingReason.summary, /only active agent/);
  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.equal(stored?.assignmentSource, "single_agent_fallback");
  assert.equal(stored?.assigneeAgentId, "agt_linear");
});

test("RoutingControlPlane assigns with classifier output when deterministic rules do not match", async () => {
  const classifierOutput: RoutingClassifierOutput = {
    taskType: "bugfix",
    requiredCapabilities: ["auth", "typescript"],
    optionalCapabilities: ["tests"],
    ownershipHints: ["login"],
    missingInfo: [],
    unmatchedCapabilities: [],
    confidence: 0.92,
    evidence: ["Issue mentions duplicate login sessions."],
  };
  const classifier: RoutingClassifier = {
    async classify(input) {
      assert.equal(input.snapshot.bodyPreview, "Login double-click creates two sessions.");
      assert.equal(input.candidates.some(candidate => candidate.agentId === "agt_auth"), true);
      return classifierOutput;
    },
  };
  const { routing, taskQueue } = createControlPlane(classifier);
  seedProfile(routing, "agt_auth", {
    capabilityTags: ["auth", "typescript", "tests"],
    ownershipTags: ["login"],
  });
  seedRuleSet(routing, [
    {
      id: "rule_docs_only",
      name: "Docs ownership",
      enabled: true,
      priority: 10,
      conditions: { issueTypes: ["documentation"] },
      target: { type: "agent", id: "agt_auth" },
      confidence: 0.5,
      explanation: "Docs only.",
    },
  ]);
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      runner: "codex",
      model: "gpt-5.4-mini",
      confidenceThreshold: 0.8,
      maxCandidates: 5,
      fallbackTriageQueueId: "triage_engineering",
      fallbackBehavior: "triage",
      timeoutMs: 30_000,
    },
  }, "agt_router", "idemp_classifier_success");

  const decision = await routing.ingestProviderIssue(makeSnapshot({
    issueType: "bug",
    title: "Duplicate login session",
    bodyPreview: "Login double-click creates two sessions.",
    capabilityTags: [],
  }), "route_classifier_success");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assignmentSource, "classifier");
  assert.equal(decision.assignment.assigneeAgentId, "agt_auth");
  assert.deepEqual(decision.routingReason.classifier?.requiredCapabilities, ["auth", "typescript"]);
  assert.equal(decision.routingReason.classifier?.suggestedTarget.id, "agt_auth");

  const stored = taskQueue.getRawTask(decision.taskId!);
  assert.equal(stored?.assignmentSource, "classifier");
  assert.equal(stored?.routingReason?.classifier?.taskType, "bugfix");
  assert.equal((stored as any)?.providerIssueSnapshot?.bodyPreview, "Login double-click creates two sessions.");
});

test("RoutingControlPlane triages low-confidence classifier output", async () => {
  const classifier: RoutingClassifier = {
    async classify() {
      return {
        taskType: "unknown",
        requiredCapabilities: ["api-design"],
        optionalCapabilities: [],
        ownershipHints: [],
        missingInfo: [],
        unmatchedCapabilities: [],
        confidence: 0.41,
        evidence: ["Issue is vague."],
      };
    },
  };
  const { routing } = createControlPlane(classifier);
  seedProfile(routing, "agt_cto");
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_router", "idemp_classifier_low_confidence");

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "documentation" }), "route_classifier_low_confidence");

  assert.equal(decision.outcome, "triage");
  assert.equal(decision.assignment.assignmentSource, "manual_triage");
  assert.deepEqual(decision.routingReason.conflictReasons, ["classifier_low_confidence"]);
});

test("RoutingControlPlane triages classifier output with unmatched capabilities", async () => {
  const classifier: RoutingClassifier = {
    async classify() {
      return {
        taskType: "feature",
        requiredCapabilities: [],
        optionalCapabilities: ["tests"],
        ownershipHints: ["iOS", "SwiftUI"],
        missingInfo: [],
        unmatchedCapabilities: ["iOS", "SwiftUI"],
        confidence: 0.92,
        evidence: ["Issue asks for native iOS work."],
      };
    },
  };
  const { routing } = createControlPlane(classifier);
  seedProfile(routing, "agt_cto", {
    capabilityTags: ["api-design", "tests"],
  });
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_router", "idemp_classifier_unmatched_capabilities");

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "feature" }), "route_classifier_unmatched_capabilities");

  assert.equal(decision.outcome, "triage");
  assert.equal(decision.assignment.assignmentSource, "manual_triage");
  assert.deepEqual(decision.routingReason.conflictReasons, [
    "classifier_unmatched_capabilities",
    "classifier_no_required_capabilities",
  ]);
  assert.deepEqual(decision.routingReason.classifier?.unmatchedCapabilities, ["iOS", "SwiftUI"]);
});

test("RoutingControlPlane best-effort assigns closest agent when configured", async () => {
  const classifier: RoutingClassifier = {
    async classify() {
      return {
        taskType: "feature",
        requiredCapabilities: [],
        optionalCapabilities: ["tests"],
        ownershipHints: ["iOS", "SwiftUI"],
        missingInfo: [],
        unmatchedCapabilities: ["iOS", "SwiftUI"],
        confidence: 0.92,
        evidence: ["Issue asks for native iOS work."],
      };
    },
  };
  const { routing } = createControlPlane(classifier);
  seedProfile(routing, "agt_backend", {
    capabilityTags: ["api-design", "tests"],
    ownershipTags: ["backend"],
  });
  seedProfile(routing, "agt_docs", {
    capabilityTags: ["documentation"],
    ownershipTags: ["docs"],
  });
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier best-effort",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
      fallbackBehavior: "assign_closest_match",
    },
  }, "agt_router", "idemp_classifier_best_effort");

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "feature" }), "route_classifier_best_effort");

  assert.equal(decision.outcome, "assigned");
  assert.equal(decision.assignment.assignmentSource, "classifier_best_effort");
  assert.equal(decision.assignment.assigneeAgentId, "agt_backend");
  assert.equal(decision.routingReason.conflictReasons.includes("classifier_best_effort"), true);
  assert.equal(decision.routingReason.classifier?.suggestedTarget.id, "agt_backend");
});

test("RoutingControlPlane triages classifier output without required capabilities", async () => {
  const classifier: RoutingClassifier = {
    async classify() {
      return {
        taskType: "unknown",
        requiredCapabilities: [],
        optionalCapabilities: ["tests"],
        ownershipHints: [],
        missingInfo: [],
        unmatchedCapabilities: [],
        confidence: 0.91,
        evidence: ["Classifier did not find a concrete required capability."],
      };
    },
  };
  const { routing } = createControlPlane(classifier);
  seedProfile(routing, "agt_cto", {
    capabilityTags: ["api-design", "tests"],
  });
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_router", "idemp_classifier_no_required_capabilities");

  const decision = await routing.ingestProviderIssue(makeSnapshot({ issueType: "maintenance" }), "route_classifier_no_required_capabilities");

  assert.equal(decision.outcome, "triage");
  assert.equal(decision.assignment.assignmentSource, "manual_triage");
  assert.deepEqual(decision.routingReason.conflictReasons, ["classifier_no_required_capabilities"]);
});

test("RoutingControlPlane retries waiting AI-routed tasks after an agent profile becomes suitable", async () => {
  const classifier: RoutingClassifier = {
    async classify(input) {
      assert.equal(input.candidates.some(candidate => candidate.agentId === "agt_mobile"), true);
      return {
        taskType: "feature",
        requiredCapabilities: ["ios", "swiftui"],
        optionalCapabilities: ["tests"],
        ownershipHints: ["mobile"],
        missingInfo: [],
        unmatchedCapabilities: [],
        confidence: 0.95,
        evidence: ["Issue asks for native iOS SwiftUI work."],
      };
    },
  };
  const { routing, taskQueue } = createControlPlane(classifier);
  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "enable classifier retry",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
      fallbackBehavior: "require_suitable_agent",
    },
  }, "agt_router", "idemp_classifier_retry");

  const first = await routing.ingestProviderIssue(makeSnapshot({
    issueType: "feature",
    title: "Build native iOS notification settings screen",
    bodyPreview: "Build a native iOS SwiftUI screen for notification preferences.",
    capabilityTags: [],
  }), "route_classifier_retry_waiting");

  assert.equal(first.outcome, "triage");
  assert.equal(first.assignment.assignmentSource, "manual_triage");
  assert.deepEqual(first.routingReason.conflictReasons, ["classifier_no_candidate_agents"]);

  seedProfile(routing, "agt_mobile", {
    capabilityTags: ["ios", "swiftui", "tests"],
    ownershipTags: ["mobile"],
  });

  const retry = await (routing as any).retryWaitingAiRoutedTasks("agt_router");

  assert.equal(retry.scanned, 1);
  assert.equal(retry.assigned, 1);
  const stored = taskQueue.getRawTask(first.taskId!);
  assert.equal(stored?.assigneeAgentId, "agt_mobile");
  assert.equal(stored?.assignmentSource, "classifier");
  assert.deepEqual(stored?.availableActions, ["start"]);
});

test("RoutingControlPlane rejects stale rule set versions during evaluation", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  await assert.rejects(
    routing.evaluate({ ruleSetVersion: 999, snapshot: makeSnapshot() }),
    (error: any) => error?.statusCode === 409
  );
});

test("RoutingControlPlane records dry-run evaluations in audit without task actions", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.evaluate({ snapshot: makeSnapshot() });
  const audit = routing.getRoutingAudit(decision.id);

  assert.equal(decision.taskId, null);
  assert.deepEqual(decision.availableActions, ["view_audit"]);
  assert.ok(audit);
  assert.equal(audit?.decision.id, decision.id);
});

test("RoutingControlPlane persists evaluation audits and replay records across instances", async () => {
  await withTempAuditStore(async (storagePath) => {
    const eventStore = new TaskEventStore({ now });
    const taskQueue = new AgentTaskQueue({ now, eventStore });
    const routing = new RoutingControlPlane({
      now,
      taskQueue,
      routingAuditStore: new RoutingAuditStore({ storagePath }),
    });
    seedProfile(routing, "agt_cto");
    seedRuleSet(routing, [
      {
        id: "rule_architecture_to_cto",
        name: "Architecture and API ownership",
        enabled: true,
        priority: 10,
        conditions: { labelsAny: ["architecture"] },
        target: { type: "agent", id: "agt_cto" },
        confidence: 0.99,
        explanation: "Architecture work maps to CTO.",
      },
    ]);

    const request = { snapshot: makeSnapshot() };
    const decision = await routing.evaluate(request, "eval_persisted");

    const restartedRouting = new RoutingControlPlane({
      now,
      taskQueue: new AgentTaskQueue({ now, eventStore: new TaskEventStore({ now }) }),
      routingAuditStore: new RoutingAuditStore({ storagePath }),
    });

    const audit = restartedRouting.getRoutingAudit(decision.id);
    assert.equal(audit?.decision.id, decision.id);
    assert.equal(audit?.ruleSet.version, 1);

    const replay = await restartedRouting.evaluate(request, "eval_persisted");
    assert.deepEqual(replay, decision);
    await assert.rejects(
      restartedRouting.evaluate({ snapshot: makeSnapshot({ sourceVersion: "2026-05-05T12:00:00Z:delivery-02" }) }, "eval_persisted"),
      (error: any) => error?.statusCode === 409
    );
  });
});

test("RoutingControlPlane persists provider intake replay records across instances", async () => {
  await withTempAuditStore(async (storagePath) => {
    const eventStore = new TaskEventStore({ now });
    const taskQueue = new AgentTaskQueue({ now, eventStore });
    const routing = new RoutingControlPlane({
      now,
      taskQueue,
      routingAuditStore: new RoutingAuditStore({ storagePath }),
    });
    seedProfile(routing, "agt_cto");
    seedRuleSet(routing, [
      {
        id: "rule_architecture_to_cto",
        name: "Architecture and API ownership",
        enabled: true,
        priority: 10,
        conditions: { labelsAny: ["architecture"] },
        target: { type: "agent", id: "agt_cto" },
        confidence: 0.99,
        explanation: "Architecture work maps to CTO.",
      },
    ]);

    const snapshot = makeSnapshot();
    const decision = await routing.ingestProviderIssue(snapshot, "intake_persisted");

    const restartedRouting = new RoutingControlPlane({
      now,
      taskQueue: new AgentTaskQueue({ now, eventStore: new TaskEventStore({ now }) }),
      routingAuditStore: new RoutingAuditStore({ storagePath }),
    });

    const audit = restartedRouting.getRoutingAudit(decision.id);
    assert.equal(audit?.decision.id, decision.id);
    assert.equal(audit?.decision.taskId, decision.taskId);

    const replay = await restartedRouting.ingestProviderIssue(snapshot, "intake_persisted");
    assert.deepEqual(replay, decision);
    await assert.rejects(
      restartedRouting.ingestProviderIssue(makeSnapshot({ sourceVersion: "2026-05-05T12:00:00Z:delivery-02" }), "intake_persisted"),
      (error: any) => error?.statusCode === 409
    );
  });
});

test("RoutingControlPlane rejects missing required snapshot fields with validation error", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  await assert.rejects(
    routing.ingestProviderIssue({
      provider: "github",
      providerIssueId: "github:oxnw/agentrail:issues/100",
      sourceVersion: "2026-05-05T12:00:00Z:delivery-invalid",
      title: "Invalid snapshot",
    } as any, "route_invalid_snapshot"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
});

test("RoutingControlPlane rejects invalid provider snapshot enum values", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const invalidSnapshots = [
    makeSnapshot({ provider: "bitbucket" as any }),
    makeSnapshot({ repository: { provider: "svn" as any, owner: "oxnw", name: "agentrail", defaultBranch: "main" } }),
    makeSnapshot({ issueType: "incident" as any }),
    makeSnapshot({ priority: "urgent" as any }),
  ];

  for (const snapshot of invalidSnapshots) {
    await assert.rejects(
      routing.ingestProviderIssue(snapshot, `route_invalid_enum_${snapshot.provider}_${snapshot.issueType}_${snapshot.priority}`),
      (error: any) =>
        error?.statusCode === 400 &&
        error?.code === "validation_error" &&
        /unsupported/i.test(error?.message ?? "")
    );
  }
});

test("RoutingControlPlane rejects provider snapshots that violate the request contract", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const invalidSnapshots = [
    makeSnapshot({ project: 123 as any }),
    makeSnapshot({ links: { providerIssue: "not a url" } }),
    makeSnapshot({ labels: Array.from({ length: 51 }, (_, index) => `label-${index}`) }),
    { ...makeSnapshot(), unexpected: true } as any,
  ];

  for (const snapshot of invalidSnapshots) {
    await assert.rejects(
      routing.ingestProviderIssue(snapshot, `route_invalid_contract_${Math.random()}`),
      (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
    );
  }
});

test("RoutingControlPlane rejects malformed agent profiles before storing them", () => {
  const { routing } = createControlPlane();

  assert.throws(
    () => routing.replaceAgentProfile("agt_bad", {
      displayName: "Bad Profile",
      role: "engineer",
      status: "active",
      maxConcurrentTasks: 1,
      sourceRef: "AGEA-99",
      changeReason: "malformed profile",
    } as any, "agt_router"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
  assert.equal(routing.getAgentProfile("agt_bad"), null);
});

test("RoutingControlPlane rejects agent profile payloads outside the published contract", () => {
  const { routing } = createControlPlane();

  const invalidProfiles = [
    {
      displayName: "Bad Profile",
      role: "engineer",
      status: "active",
      capabilityTags: [],
      ownershipTags: [],
      repoAllowlist: [],
      maxConcurrentTasks: 1,
      sourceRef: "AGEA-99",
      changeReason: "malformed profile",
      unsupportedField: true,
    },
    {
      displayName: "Bad Profile",
      role: "engineer",
      status: "active",
      capabilityTags: [],
      ownershipTags: [],
      repoAllowlist: [],
      maxConcurrentTasks: -1,
      sourceRef: "AGEA-99",
      changeReason: "malformed profile",
    },
    {
      displayName: "Bad Profile",
      role: "engineer",
      status: "active",
      capabilityTags: Array.from({ length: 51 }, (_, index) => `cap-${index}`),
      ownershipTags: [],
      repoAllowlist: [],
      maxConcurrentTasks: 1,
      sourceRef: "AGEA-99",
      changeReason: "malformed profile",
    },
  ];

  for (const profile of invalidProfiles) {
    assert.throws(
      () => routing.replaceAgentProfile("agt_bad", profile as any, "agt_router"),
      (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
    );
  }
  assert.equal(routing.getAgentProfile("agt_bad"), null);
});

test("RoutingControlPlane rejects rule sets without source metadata before storing them", () => {
  const { routing } = createControlPlane();

  assert.throws(
    () => routing.replaceRuleSet({
      changeReason: "missing source ref",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
    } as any, "agt_router", "idemp_missing_source_ref"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
  assert.equal(routing.getCurrentRuleSet(), null);

  assert.throws(
    () => routing.replaceRuleSet({
      sourceRef: "AGEA-99",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
    } as any, "agt_router", "idemp_missing_change_reason"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
  assert.equal(routing.getCurrentRuleSet(), null);
});

test("RoutingControlPlane rejects rule sets without classifier config before storing them", () => {
  const { routing } = createControlPlane();

  assert.throws(
    () => routing.replaceRuleSet({
      sourceRef: "AGEA-99",
      changeReason: "missing classifier",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
        },
      ],
    } as any, "agt_router", "idemp_missing_classifier"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
  assert.equal(routing.getCurrentRuleSet(), null);
});

test("RoutingControlPlane accepts classifier timeout up to ten minutes", () => {
  const { routing } = createControlPlane();

  routing.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "allow slow local routing classifier",
    rules: [],
    classifier: {
      enabled: true,
      provider: "local_runner",
      runner: "codex",
      confidenceThreshold: 0.8,
      maxCandidates: 5,
      fallbackTriageQueueId: "triage_engineering",
      fallbackBehavior: "require_suitable_agent",
      timeoutMs: 600_000,
    },
  }, "agt_router", "idemp_classifier_timeout_max");

  assert.equal(routing.getCurrentRuleSet()?.classifier.timeoutMs, 600_000);
});

test("RoutingControlPlane rejects classifier timeout above ten minutes", () => {
  const { routing } = createControlPlane();

  assert.throws(
    () => routing.replaceRuleSet({
      sourceRef: "AGEA-99",
      changeReason: "reject overly slow local routing classifier",
      rules: [],
      classifier: {
        enabled: true,
        provider: "local_runner",
        runner: "codex",
        confidenceThreshold: 0.8,
        maxCandidates: 5,
        fallbackTriageQueueId: "triage_engineering",
        fallbackBehavior: "require_suitable_agent",
        timeoutMs: 600_001,
      },
    }, "agt_router", "idemp_classifier_timeout_too_high"),
    (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
  );
  assert.equal(routing.getCurrentRuleSet(), null);
});

test("RoutingControlPlane rejects rule-set payloads with unsupported response fields", () => {
  const invalidRuleSets = [
    {
      sourceRef: "AGEA-99",
      changeReason: "extra classifier field",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
        unexpected: true,
      },
    },
    {
      sourceRef: "AGEA-99",
      changeReason: "extra rule field",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto" },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
          unexpected: true,
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
    },
    {
      sourceRef: "AGEA-99",
      changeReason: "extra target field",
      rules: [
        {
          id: "rule_architecture_to_cto",
          name: "Architecture ownership",
          enabled: true,
          priority: 10,
          conditions: { labelsAny: ["architecture"] },
          target: { type: "agent", id: "agt_cto", unexpected: true },
          confidence: 0.99,
          explanation: "Architecture work maps to CTO.",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
    },
  ];

  for (const [index, payload] of invalidRuleSets.entries()) {
    const { routing } = createControlPlane();
    assert.throws(
      () => routing.replaceRuleSet(payload as any, "agt_router", `idemp_invalid_contract_rule_set_${index}`),
      (error: any) => error?.statusCode === 400 && error?.code === "validation_error"
    );
    assert.equal(routing.getCurrentRuleSet(), null);
  }
});

test("RoutingControlPlane exposes audit lookups for recorded decisions", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto");
  seedRuleSet(routing, [
    {
      id: "rule_architecture_to_cto",
      name: "Architecture and API ownership",
      enabled: true,
      priority: 10,
      conditions: { labelsAny: ["architecture"] },
      target: { type: "agent", id: "agt_cto" },
      confidence: 0.99,
      explanation: "Architecture work maps to CTO.",
    },
  ]);

  const decision = await routing.ingestProviderIssue(makeSnapshot(), "route_audit");
  const audit = routing.getRoutingAudit(decision.id);

  assert.ok(audit);
  assert.equal(audit?.decision.id, decision.id);
  assert.equal(audit?.ruleSet.version, 1);
  assert.ok(audit?.inputDigest.startsWith("sha256:"));
});

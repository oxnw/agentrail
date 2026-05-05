import test from "node:test";
import assert from "node:assert/strict";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import {
  RoutingControlPlane,
  type AgentProfileReplaceRequest,
  type ProviderIssueSnapshot,
  type RoutingRule,
} from "../src/intake-routing-control-plane.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const FIXED_NOW = new Date("2026-05-05T12:00:00Z");
const now = () => FIXED_NOW;

function createControlPlane() {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routing = new RoutingControlPlane({ now, taskQueue });
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
    providerAssignees: ["cto-github-login"],
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
    providerIdentityMappings: [{ provider: "github", subject: `${agentId}-github` }],
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

test("RoutingControlPlane deterministically assigns and persists routing metadata", async () => {
  const { routing, taskQueue } = createControlPlane();
  seedProfile(routing, "agt_cto", {
    providerIdentityMappings: [{ provider: "github", subject: "cto-github-login" }],
  });
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

test("RoutingControlPlane sends ambiguous matches to triage", async () => {
  const { routing } = createControlPlane();
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

test("RoutingControlPlane exposes audit lookups for recorded decisions", async () => {
  const { routing } = createControlPlane();
  seedProfile(routing, "agt_cto", {
    providerIdentityMappings: [{ provider: "github", subject: "cto-github-login" }],
  });
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

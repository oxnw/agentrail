// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

test("routing rule updates require routing:admin instead of normal task scopes", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: workerKey } = authStore.createKey({
    agent: { id: "agt_worker", displayName: "Worker", role: "engineer", externalIdentities: [] },
    scopes: ["tasks:read", "tasks:write"],
  }, "idemp_worker_key");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/operator/routing/rule-sets/current`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_rule_update",
      },
      body: JSON.stringify({
        sourceRef: "AGEA-99",
        changeReason: "attempt unauthorized rule update",
        rules: [
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
        ],
        classifier: {
          enabled: false,
          provider: "internal-router",
          confidenceThreshold: 0.82,
          maxCandidates: 3,
          fallbackTriageQueueId: "triage_engineering",
        },
      }),
    });

    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.code, "insufficient_scope");
    assert.equal(json.error.details.requiredScope, "routing:admin");
  } finally {
    server.close();
  }
});

test("operator intake route records a task assignment and exposes audit lookup", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin", "routing:read", "routing:evaluate"],
  }, "idemp_operator_key");

  routingControlPlane.replaceAgentProfile("agt_cto", {
    displayName: "CTO",
    role: "cto",
    status: "active",
    capabilityTags: ["api-design", "architecture"],
    ownershipTags: ["control-plane"],
    repoAllowlist: ["oxnw/agentrail"],
    providerIdentityMappings: [{ provider: "github", subject: "cto-github-login" }],
    maxConcurrentTasks: 5,
    sourceRef: "AGEA-99",
    changeReason: "seed profile for endpoint test",
  }, "agt_operator");

  routingControlPlane.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "seed rule set for endpoint test",
    rules: [
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
    ],
    classifier: {
      enabled: false,
      provider: "internal-router",
      confidenceThreshold: 0.82,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_engineering",
    },
  }, "agt_operator", "idemp_rule_seed");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const intakeRes = await fetch(`${baseUrl}/operator/intake/provider-issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_operator_intake",
      },
      body: JSON.stringify({
        provider: "github",
        providerIssueId: "github:oxnw/agentrail:issues/101",
        sourceVersion: "2026-05-05T12:00:00Z:delivery-01",
        repository: {
          provider: "github",
          owner: "oxnw",
          name: "agentrail",
          defaultBranch: "main",
        },
        title: "Route architecture issue",
        bodyDigest: "sha256:route-test",
        labels: ["architecture", "api"],
        providerAssignees: ["cto-github-login"],
        project: "Documentation",
        issueType: "architecture",
        priority: "high",
        ownershipTags: ["control-plane"],
        capabilityTags: ["api-design", "architecture"],
        links: {
          providerIssue: "https://github.com/oxnw/agentrail/issues/101",
        },
      }),
    });

    assert.equal(intakeRes.status, 202);
    const intakeJson = await intakeRes.json();
    assert.equal(intakeJson.data.assignment.assigneeAgentId, "agt_cto");
    assert.equal(intakeJson.data.assignment.assignmentSource, "deterministic_rule");
    assert.ok(intakeJson.data.taskId);

    const stored = taskQueue.getRawTask(intakeJson.data.taskId);
    assert.equal(stored?.assigneeAgentId, "agt_cto");
    assert.equal(stored?.routingDecisionId, intakeJson.data.id);

    const auditRes = await fetch(`${baseUrl}/operator/routing/audit/${intakeJson.data.id}`, {
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
      },
    });

    assert.equal(auditRes.status, 200);
    const auditJson = await auditRes.json();
    assert.equal(auditJson.data.decision.id, intakeJson.data.id);
    assert.equal(auditJson.data.ruleSet.version, 1);
  } finally {
    server.close();
  }
});

test("routing endpoints default availableActions and emit unique req_ ids even in the same millisecond", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const authStore = new AgentAuthStore({ now });
  const originalDateNow = Date.now;

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin", "routing:evaluate"],
  }, "idemp_operator_endpoint_guard");

  const server = createServer({
    store: eventStore,
    authStore,
    routingControlPlane: {
      async evaluate() {
        return { decision: { matched: true } };
      },
      async ingestProviderIssue() {
        return {
          id: "rdec_endpoint_guard",
          taskId: "tsk_endpoint_guard",
          assignment: {
            assigneeAgentId: "agt_cto",
            assignmentSource: "deterministic_rule",
          },
        };
      },
    },
    now,
  });

  const baseUrl = await listen(server);

  try {
    Date.now = () => 1746446400000;

    const evaluationRes = await fetch(`${baseUrl}/operator/routing/evaluations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ providerIssueId: "github:oxnw/agentrail:issues/201" }),
    });

    assert.equal(evaluationRes.status, 200);
    const evaluationJson = await evaluationRes.json();
    assert.deepEqual(evaluationJson.availableActions, []);
    assert.match(evaluationJson.meta.requestId, /^req_/);

    const intakeRes = await fetch(`${baseUrl}/operator/intake/provider-issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ providerIssueId: "github:oxnw/agentrail:issues/202" }),
    });

    assert.equal(intakeRes.status, 202);
    const intakeJson = await intakeRes.json();
    assert.deepEqual(intakeJson.availableActions, []);
    assert.match(intakeJson.meta.requestId, /^req_/);
    assert.notEqual(evaluationJson.meta.requestId, intakeJson.meta.requestId);
  } finally {
    Date.now = originalDateNow;
    server.close();
  }
});

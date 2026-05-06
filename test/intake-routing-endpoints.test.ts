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

function makeRoutingSnapshot(overrides = {}) {
  return {
    provider: "github",
    providerIssueId: "github:oxnw/agentrail:issues/102",
    sourceVersion: "2026-05-05T12:00:00Z:delivery-02",
    repository: {
      provider: "github",
      owner: "oxnw",
      name: "agentrail",
      defaultBranch: "main",
    },
    title: "Dry-run architecture issue",
    bodyDigest: "sha256:eval-test",
    labels: ["architecture", "api"],
    providerAssignees: ["cto-github-login"],
    issueType: "architecture",
    priority: "high",
    ownershipTags: ["control-plane"],
    capabilityTags: ["api-design", "architecture"],
    links: {
      providerIssue: "https://github.com/oxnw/agentrail/issues/102",
    },
    ...overrides,
  };
}

function seedRoutingForEvaluation(routingControlPlane) {
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
    changeReason: "seed profile for evaluation test",
  }, "agt_operator");

  routingControlPlane.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "seed rule set for evaluation test",
    rules: [
      {
        id: "rule_architecture_to_cto",
        name: "Architecture and API ownership",
        enabled: true,
        priority: 10,
        conditions: {
          repositories: ["oxnw/agentrail"],
          labelsAny: ["architecture", "api"],
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
  }, "agt_operator", "idemp_eval_rule_seed");
}

function makeAgentProfilePayload(overrides = {}) {
  return {
    displayName: "CTO",
    role: "cto",
    status: "active",
    capabilityTags: ["api-design", "architecture"],
    ownershipTags: ["control-plane"],
    repoAllowlist: ["oxnw/agentrail"],
    providerIdentityMappings: [{ provider: "github", subject: "cto-github-login" }],
    maxConcurrentTasks: 5,
    sourceRef: "AGEA-99",
    changeReason: "seed CTO routing profile",
    ...overrides,
  };
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

test("routing rule replacement requires an Idempotency-Key", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin"],
  }, "idemp_operator_no_idempotency_key");

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
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceRef: "AGEA-99",
        changeReason: "attempt rule update without idempotency",
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

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "validation_error");
    assert.match(json.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("routing mutations reject Idempotency-Key values outside documented bounds", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin"],
  }, "idemp_operator_short_key");

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
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "short",
      },
      body: JSON.stringify({
        sourceRef: "AGEA-99",
        changeReason: "attempt rule update with short idempotency key",
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

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "validation_error");
    assert.match(json.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("routing profile replacement requires an Idempotency-Key", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin"],
  }, "idemp_operator_profile_no_idempotency_key");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_cto`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(makeAgentProfilePayload()),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "validation_error");
    assert.match(json.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("routing profile replacement replays identical Idempotency-Key responses", async () => {
  let tick = 0;
  const baseTime = Date.parse("2026-05-05T12:00:00Z");
  const now = () => new Date(baseTime + tick++ * 1000);
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin"],
  }, "idemp_operator_profile_replay");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);
  const replaceProfile = (body) => fetch(`${baseUrl}/operator/routing/agent-profiles/agt_cto`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${operatorKey.apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "profile-replay-01",
    },
    body: JSON.stringify(body),
  });

  try {
    const payload = makeAgentProfilePayload();
    const firstRes = await replaceProfile(payload);
    const secondRes = await replaceProfile(payload);

    assert.equal(firstRes.status, 200);
    assert.equal(secondRes.status, 200);
    const firstJson = await firstRes.json();
    const secondJson = await secondRes.json();
    assert.equal(secondJson.data.updatedAt, firstJson.data.updatedAt);
    assert.deepEqual(secondJson.data, firstJson.data);

    const conflictRes = await replaceProfile(makeAgentProfilePayload({
      role: "principal-engineer",
      changeReason: "different profile payload",
    }));

    assert.equal(conflictRes.status, 409);
    const conflictJson = await conflictRes.json();
    assert.equal(conflictJson.error.code, "conflict");
    assert.match(conflictJson.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("provider issue intake requires an Idempotency-Key", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin"],
  }, "idemp_operator_intake_no_idempotency_key");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/operator/intake/provider-issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        providerIssueId: "github:oxnw/agentrail:issues/101",
        sourceVersion: "2026-05-05T12:00:00Z:delivery-01",
        title: "Route architecture issue",
      }),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "validation_error");
    assert.match(json.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("routing evaluation requires an Idempotency-Key", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:evaluate"],
  }, "idemp_operator_eval_no_idempotency_key");

  seedRoutingForEvaluation(routingControlPlane);

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/operator/routing/evaluations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        snapshot: makeRoutingSnapshot(),
      }),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "validation_error");
    assert.match(json.error.message, /Idempotency-Key/i);
  } finally {
    server.close();
  }
});

test("routing evaluation replays identical Idempotency-Key responses", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:evaluate"],
  }, "idemp_operator_eval_replay");

  seedRoutingForEvaluation(routingControlPlane);

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);
  const evaluate = (body) => fetch(`${baseUrl}/operator/routing/evaluations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorKey.apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "eval-replay-01",
    },
    body: JSON.stringify(body),
  });

  try {
    const payload = { snapshot: makeRoutingSnapshot() };
    const firstRes = await evaluate(payload);
    const secondRes = await evaluate(payload);

    assert.equal(firstRes.status, 200);
    assert.equal(secondRes.status, 200);
    const firstJson = await firstRes.json();
    const secondJson = await secondRes.json();
    assert.equal(secondJson.data.id, firstJson.data.id);
    assert.deepEqual(secondJson.data, firstJson.data);

    const conflictRes = await evaluate({
      snapshot: makeRoutingSnapshot({
        sourceVersion: "2026-05-05T12:01:00Z:delivery-03",
      }),
    });

    assert.equal(conflictRes.status, 409);
    const conflictJson = await conflictRes.json();
    assert.equal(conflictJson.error.code, "conflict");
    assert.match(conflictJson.error.message, /Idempotency-Key/i);
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

test("operator dry-run evaluation records an audit lookup without a task action", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue });
  const authStore = new AgentAuthStore({ now });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "cto", externalIdentities: [] },
    scopes: ["routing:admin", "routing:read", "routing:evaluate"],
  }, "idemp_operator_evaluate_key");

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
    changeReason: "seed profile for evaluation audit endpoint test",
  }, "agt_operator");

  routingControlPlane.replaceRuleSet({
    sourceRef: "AGEA-99",
    changeReason: "seed rule set for evaluation audit endpoint test",
    rules: [
      {
        id: "rule_architecture_to_cto",
        name: "Architecture and API ownership",
        enabled: true,
        priority: 10,
        conditions: {
          repositories: ["oxnw/agentrail"],
          labelsAny: ["architecture", "api"],
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
  }, "agt_operator", "idemp_eval_rule_seed");

  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const evaluateRes = await fetch(`${baseUrl}/operator/routing/evaluations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "eval-dry-run-01",
      },
      body: JSON.stringify({
        snapshot: {
          provider: "github",
          providerIssueId: "github:oxnw/agentrail:issues/102",
          sourceVersion: "2026-05-05T12:00:00Z:delivery-02",
          repository: {
            provider: "github",
            owner: "oxnw",
            name: "agentrail",
            defaultBranch: "main",
          },
          title: "Dry-run architecture issue",
          bodyDigest: "sha256:eval-test",
          labels: ["architecture", "api"],
          providerAssignees: ["cto-github-login"],
          issueType: "architecture",
          priority: "high",
          ownershipTags: ["control-plane"],
          capabilityTags: ["api-design", "architecture"],
          links: {
            providerIssue: "https://github.com/oxnw/agentrail/issues/102",
          },
        },
      }),
    });

    assert.equal(evaluateRes.status, 200);
    const evaluateJson = await evaluateRes.json();
    assert.equal(evaluateJson.data.taskId, null);
    assert.deepEqual(evaluateJson.data.availableActions, ["view_audit"]);

    const auditRes = await fetch(`${baseUrl}/operator/routing/audit/${evaluateJson.data.id}`, {
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
      },
    });

    assert.equal(auditRes.status, 200);
    const auditJson = await auditRes.json();
    assert.equal(auditJson.data.decision.id, evaluateJson.data.id);
  } finally {
    server.close();
  }
});

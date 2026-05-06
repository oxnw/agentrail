import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentProfileStore } from "../src/agent-profile-store.ts";
import { RoutingRuleStore } from "../src/routing-rule-store.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress !== "string");
  const { address, port } = serverAddress;
  return `http://${address}:${port}`;
}

const now = () => new Date("2026-05-05T12:00:00Z");

function tmpPath(suffix: string) {
  return path.join(os.tmpdir(), `agentrail-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}.json`);
}

async function setupServer({
  profileStoragePath,
  ruleSetStoragePath,
}: {
  profileStoragePath?: string;
  ruleSetStoragePath?: string;
} = {}) {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const authStore = new AgentAuthStore({ now });
  const agentProfileStore = new AgentProfileStore({ now, storagePath: profileStoragePath });
  const routingRuleStore = new RoutingRuleStore({ now, storagePath: ruleSetStoragePath });
  const routingControlPlane = new RoutingControlPlane({ now, taskQueue, agentProfileStore, routingRuleStore });

  const { data: operatorKey } = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "operator", externalIdentities: [] },
    scopes: ["routing:admin", "routing:read", "routing:evaluate"],
  }, "idemp_operator_key");

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
  return { server, baseUrl, operatorKey, workerKey, taskQueue };
}

async function seedAgentProfile({
  baseUrl,
  operatorKey,
  agentId,
  displayName = "Engineer",
}: {
  baseUrl: string;
  operatorKey: { apiKey: string };
  agentId: string;
  displayName?: string;
}) {
  const res = await fetch(`${baseUrl}/operator/routing/agent-profiles/${agentId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${operatorKey.apiKey}`,
      "content-type": "application/json",
      "idempotency-key": `idemp_seed_profile_${agentId}`,
    },
    body: JSON.stringify({
      displayName,
      role: "engineer",
      status: "active",
      capabilityTags: ["code"],
      ownershipTags: ["backend"],
      repoAllowlist: ["oxnw/agentrail"],
      providerIdentityMappings: [{ provider: "github", subject: `${agentId}-github` }],
      maxConcurrentTasks: 4,
      sourceRef: "AGEA-132",
      changeReason: "seed setup verification profile",
    }),
  });
  assert.equal(res.status, 200);
}

test("GET /operator/routing/agent-profiles/{agentId} returns profile for authorized operator", async () => {
  const { server, baseUrl, operatorKey } = await setupServer();
  try {
    const putRes = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_seed_profile",
      },
      body: JSON.stringify({
        displayName: "Engineer",
        role: "engineer",
        status: "active",
        capabilityTags: ["code"],
        ownershipTags: ["backend"],
        repoAllowlist: ["oxnw/agentrail"],
        providerIdentityMappings: [{ provider: "github", subject: "eng" }],
        maxConcurrentTasks: 4,
        sourceRef: "AGEA-131",
        changeReason: "seed for test",
      }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      headers: { authorization: `Bearer ${operatorKey.apiKey}` },
    });
    assert.equal(getRes.status, 200);
    const json = await getRes.json();
    assert.equal(json.data.displayName, "Engineer");
    assert.equal(json.data.source, "operator_admin");
  } finally {
    server.close();
  }
});

test("PUT /operator/routing/agent-profiles/{agentId} rejects worker without routing:admin", async () => {
  const { server, baseUrl, workerKey } = await setupServer();
  try {
    const res = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_unauthorized",
      },
      body: JSON.stringify({
        displayName: "Engineer",
        role: "engineer",
        status: "active",
        capabilityTags: ["code"],
        ownershipTags: ["backend"],
        repoAllowlist: ["oxnw/agentrail"],
        providerIdentityMappings: [{ provider: "github", subject: "eng" }],
        maxConcurrentTasks: 4,
        sourceRef: "AGEA-131",
        changeReason: "seed for test",
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

test("GET /operator/routing/agent-profiles/{agentId} rejects worker without routing:read", async () => {
  const { server, baseUrl, operatorKey, workerKey } = await setupServer();
  try {
    const putRes = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_seed",
      },
      body: JSON.stringify({
        displayName: "Engineer",
        role: "engineer",
        status: "active",
        capabilityTags: ["code"],
        ownershipTags: ["backend"],
        repoAllowlist: ["oxnw/agentrail"],
        providerIdentityMappings: [{ provider: "github", subject: "eng" }],
        maxConcurrentTasks: 4,
        sourceRef: "AGEA-131",
        changeReason: "seed for test",
      }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      headers: { authorization: `Bearer ${workerKey.apiKey}` },
    });
    assert.equal(getRes.status, 403);
    const json = await getRes.json();
    assert.equal(json.error.code, "insufficient_scope");
  } finally {
    server.close();
  }
});

test("GET /tasks/{taskId} authorizes against canonical assigneeAgentId", async () => {
  const { server, baseUrl, workerKey, taskQueue } = await setupServer();
  try {
    const task = taskQueue.createTask({
      identifier: "github:oxnw/agentrail:issues/canonical-assignee",
      title: "Canonical assignment visibility",
      description: "Display assignee can differ from the AgentRail agent id.",
      status: "in_progress",
      priority: "medium",
      assignee: { id: "github-login", name: "GitHub Login" },
      assigneeAgentId: "agt_worker",
      acceptanceCriteria: [],
      links: { issue: "https://github.com/oxnw/agentrail/issues/canonical-assignee" },
      context: { project: "oxnw/agentrail", goal: "Visibility test" },
      availableActions: ["submit"],
    });

    const res = await fetch(`${baseUrl}/tasks/${task.id}`, {
      headers: { authorization: `Bearer ${workerKey.apiKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.assignee.id, "github-login");
    assert.equal(body.data.assigneeAgentId, "agt_worker");
  } finally {
    server.close();
  }
});

test("routing profile and rule-set endpoints reload persisted state after restart", async () => {
  const ruleSetPath = tmpPath("rules");
  const profilePath = tmpPath("profiles");

  const { server: srv1, baseUrl: url1, operatorKey } = await setupServer({ ruleSetStoragePath: ruleSetPath, profileStoragePath: profilePath });
  try {
    const profileRes = await fetch(`${url1}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_profile_persist_e2e",
      },
      body: JSON.stringify({
        displayName: "Persistent Engineer",
        role: "engineer",
        status: "active",
        capabilityTags: ["code"],
        ownershipTags: ["backend"],
        repoAllowlist: ["oxnw/agentrail"],
        providerIdentityMappings: [{ provider: "github", subject: "persistent-engineer" }],
        maxConcurrentTasks: 4,
        sourceRef: "AGEA-120",
        changeReason: "persist profile test",
      }),
    });
    assert.equal(profileRes.status, 200);

    const putRes = await fetch(`${url1}/operator/routing/rule-sets/current`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_rule_persist",
      },
      body: JSON.stringify({
        sourceRef: "AGEA-131",
        changeReason: "persist test",
        rules: [
          {
            id: "rule_to_eng",
            name: "Backend ownership",
            enabled: true,
            priority: 5,
            conditions: { labelsAny: ["backend"] },
            target: { type: "agent", id: "agt_engineer" },
            confidence: 0.9,
            explanation: "Backend work goes to engineer.",
          },
        ],
        classifier: {
          enabled: false,
          provider: "internal-router",
          confidenceThreshold: 0.82,
          maxCandidates: 3,
          fallbackTriageQueueId: "triage_default",
        },
      }),
    });
    assert.equal(putRes.status, 201);
    const body = await putRes.json();
    assert.equal(body.data.version, 1);
  } finally {
    srv1.close();
  }

  const { server: srv2, baseUrl: url2, operatorKey: operatorKey2 } = await setupServer({ ruleSetStoragePath: ruleSetPath, profileStoragePath: profilePath });
  try {
    const profileRes = await fetch(`${url2}/operator/routing/agent-profiles/agt_engineer`, {
      headers: {
        authorization: `Bearer ${operatorKey2.apiKey}`,
      },
    });
    assert.equal(profileRes.status, 200);
    const profileBody = await profileRes.json();
    assert.equal(profileBody.data.displayName, "Persistent Engineer");

    const getRes = await fetch(`${url2}/operator/routing/rule-sets/current`, {
      headers: {
        authorization: `Bearer ${operatorKey2.apiKey}`,
      },
    });
    assert.equal(getRes.status, 200);
    const ruleSetBody = await getRes.json();
    assert.equal(ruleSetBody.data.version, 1);
    assert.equal(ruleSetBody.data.rules[0]?.id, "rule_to_eng");
  } finally {
    srv2.close();
    fs.rmSync(ruleSetPath, { force: true });
    fs.rmSync(profilePath, { force: true });
  }
});

test("RoutingRuleStore persists and reloads rule sets across restarts", async (t) => {
  const storagePath = tmpPath("rules");
  t.after(() => {
    fs.rmSync(storagePath, { force: true });
  });

  const store1 = new RoutingRuleStore({ now, storagePath });
  const created = store1.replaceRuleSet(
    {
      sourceRef: "AGEA-131",
      changeReason: "persist",
      rules: [
        {
          id: "rule_1",
          name: "Rule 1",
          enabled: true,
          priority: 1,
          conditions: {},
          target: { type: "agent", id: "agt_a" },
          confidence: 0.9,
          explanation: "e2e",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage",
      },
    },
    "agt_operator",
    "idemp_persist"
  );
  assert.equal(created.version, 1);

  const store2 = new RoutingRuleStore({ now, storagePath });
  const current = store2.getCurrentRuleSet();
  assert.ok(current);
  assert.equal(current?.id, created.id);
  assert.equal(current?.rules[0].id, "rule_1");
});

test("AgentProfileStore persists and reloads profiles across restarts", async (t) => {
  const storagePath = tmpPath("profiles");
  t.after(() => {
    fs.rmSync(storagePath, { force: true });
  });

  const store1 = new AgentProfileStore({ now, storagePath });
  const created = store1.replaceAgentProfile(
    "agt_test",
    {
      displayName: "Test",
      role: "qa",
      status: "active",
      capabilityTags: ["test"],
      ownershipTags: ["qa"],
      repoAllowlist: [],
      providerIdentityMappings: [],
      maxConcurrentTasks: 2,
      sourceRef: "AGEA-131",
      changeReason: "persist",
    },
    "agt_operator",
    "idemp_profile_persist"
  );
  assert.equal(created.displayName, "Test");

  const store2 = new AgentProfileStore({ now, storagePath });
  const loaded = store2.getAgentProfile("agt_test");
  assert.ok(loaded);
  assert.equal(loaded?.displayName, "Test");
});

test("PUT /operator/routing/rule-sets/current is idempotent", async () => {
  const { server, baseUrl, operatorKey } = await setupServer();
  try {
    const payload = {
      sourceRef: "AGEA-131",
      changeReason: "idempotency test",
      rules: [
        {
          id: "rule_idemp",
          name: "Idempotency rule",
          enabled: true,
          priority: 1,
          conditions: {},
          target: { type: "agent", id: "agt_a" },
          confidence: 0.9,
          explanation: "idempotency",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage",
      },
    };

    const res1 = await fetch(`${baseUrl}/operator/routing/rule-sets/current`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_ruleset_v1",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 201);
    const body1 = await res1.json();

    const res2 = await fetch(`${baseUrl}/operator/routing/rule-sets/current`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_ruleset_v1",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 201);
    const body2 = await res2.json();
    assert.equal(body2.data.id, body1.data.id);
  } finally {
    server.close();
  }
});

test("PUT /operator/routing/agent-profiles/{agentId} is idempotent", async () => {
  const { server, baseUrl, operatorKey } = await setupServer();
  try {
    const payload = {
      displayName: "Engineer",
      role: "engineer",
      status: "active",
      capabilityTags: ["code"],
      ownershipTags: ["backend"],
      repoAllowlist: ["oxnw/agentrail"],
      providerIdentityMappings: [{ provider: "github", subject: "eng" }],
      maxConcurrentTasks: 4,
      sourceRef: "AGEA-131",
      changeReason: "idempotency",
    };

    const res1 = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_profile_idemp",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();

    const res2 = await fetch(`${baseUrl}/operator/routing/agent-profiles/agt_engineer`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "idemp_profile_idemp",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.data.updatedAt, body1.data.updatedAt);
  } finally {
    server.close();
  }
});

test("POST /operator/setup/verification-task creates a deterministic setup smoke task for the selected agent", async () => {
  const { server, baseUrl, operatorKey, taskQueue } = await setupServer();
  try {
    await seedAgentProfile({
      baseUrl,
      operatorKey,
      agentId: "agt_setup",
      displayName: "Setup Agent",
    });

    const res1 = await fetch(`${baseUrl}/operator/setup/verification-task`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "setup-verification:agt_setup:v1",
      },
      body: JSON.stringify({
        agentId: "agt_setup",
        sourceRef: "agentrail-cli:init",
      }),
    });
    assert.equal(res1.status, 201);
    const body1 = await res1.json();
    assert.equal(body1.data.agentId, "agt_setup");
    assert.equal(body1.data.status, "in_progress");
    assert.deepEqual(body1.availableActions, ["submit"]);

    const stored = taskQueue.getRawTask(body1.data.taskId);
    assert.ok(stored);
    assert.equal(stored?.identifier, "LOCAL-SETUP-AGT-SETUP");
    assert.equal(stored?.assigneeAgentId, "agt_setup");
    assert.equal(stored?.status, "in_progress");
    assert.deepEqual(stored?.availableActions, ["submit"]);
    assert.equal(stored?.source?.provider, "agentrail_setup");
    assert.equal(stored?.source?.repo, "agentrail");

    const res2 = await fetch(`${baseUrl}/operator/setup/verification-task`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "setup-verification:agt_setup:v1",
      },
      body: JSON.stringify({
        agentId: "agt_setup",
        sourceRef: "agentrail-cli:init",
      }),
    });
    assert.equal(res2.status, 201);
    const body2 = await res2.json();
    assert.equal(body2.data.taskId, body1.data.taskId);
    assert.equal(body2.data.taskIdentifier, body1.data.taskIdentifier);
  } finally {
    server.close();
  }
});

test("POST /operator/setup/verification-task rejects worker without routing:admin", async () => {
  const { server, baseUrl, operatorKey, workerKey } = await setupServer();
  try {
    await seedAgentProfile({
      baseUrl,
      operatorKey,
      agentId: "agt_setup",
      displayName: "Setup Agent",
    });

    const res = await fetch(`${baseUrl}/operator/setup/verification-task`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerKey.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": "setup-verification:agt_setup:unauthorized",
      },
      body: JSON.stringify({
        agentId: "agt_setup",
        sourceRef: "agentrail-cli:init",
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

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { GitHubIssueIntakeAdapter } from "../src/github-issue-intake-adapter.ts";
import { LinearIssueSourceAdapter } from "../src/linear-issue-source-adapter.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

/**
 * @param {import("node:http").Server} server
 */
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return `http://${address}:${port}`;
}

function createTestServer({
  now,
  createAdapter = null,
  adapterKey,
  withAuth = false,
}) {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const authStore = withAuth ? new AgentAuthStore({ now }) : null;
  const adapter = typeof createAdapter === "function" ? createAdapter(taskQueue) : null;
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    [adapterKey]: adapter,
    authStore: authStore ?? undefined,
    now,
  });

  return { eventStore, taskQueue, authStore, server };
}

test("POST /providers/github/intake creates a task and returns 201", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const { taskQueue, authStore, server } = createTestServer({
    now,
    adapterKey: "intakeAdapter",
    createAdapter: (queue) => new GitHubIssueIntakeAdapter({ taskQueue: queue }),
    withAuth: true,
  });
  const { data: testKey } = authStore.createKey({ name: "test", agent: { id: "agt_test", displayName: "Test Agent", role: "developer", externalIdentities: [] }, scopes: ["tasks:write", "tasks:read"] }, "idemp_test");
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/github/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${testKey.apiKey}`,
        "idempotency-key": "idemp_01GITHUBINTAKE",
      },
      body: JSON.stringify({
        issueNumber: 42,
        issueUrl: "https://github.com/oxnw/agentrail/issues/42",
        issueTitle: "E2E intake test issue",
        body: "## Acceptance Criteria\n- [ ] Endpoint returns 201",
        labels: ["high-priority"],
        state: "open",
        repository: { owner: "oxnw", repo: "agentrail" },
        assignees: [{ login: "agt_test" }],
      }),
    });

    const bodyText = await res.text();
    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);
    const json = JSON.parse(bodyText);
    assert.ok(json.data.taskId.startsWith("tsk_"));
    assert.strictEqual(json.data.identifier, "github:oxnw/agentrail:issues/42");
    assert.strictEqual(json.data.status, "todo");
    assert.deepStrictEqual(json.availableActions, ["get_task"]);

    const stored = taskQueue.getRawTask(json.data.taskId);
    assert.ok(stored);
    assert.strictEqual(stored.title, "E2E intake test issue");
  } finally {
    server.close();
  }
});

test("POST /providers/github/intake returns 404 when intake adapter is missing", async () => {
  const eventStore = new TaskEventStore({ now: () => new Date() });
  const authStore = new AgentAuthStore({ now: () => new Date() });
  const { data: writeKey } = authStore.createKey({ name: "write", agent: { id: "agt_test", displayName: "Test Agent", role: "developer", externalIdentities: [] }, scopes: ["tasks:write"] }, "idemp_write");

  const server = createServer({
    store: eventStore,
    intakeAdapter: null,
    authStore,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/github/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${writeKey.apiKey}`,
      },
      body: JSON.stringify({
        issueNumber: 1,
        issueUrl: "https://github.com/oxnw/agentrail/issues/1",
        issueTitle: "Should fail",
      }),
    });

    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.error.code, "not_found");
    assert.ok(json.error.message.includes("intake"));
  } finally {
    server.close();
  }
});

test("POST /providers/github/intake returns 403 without tasks:write scope", async () => {
  const eventStore = new TaskEventStore({ now: () => new Date() });
  const authStore = new AgentAuthStore({ now: () => new Date() });
  const { data: readKey } = authStore.createKey({ name: "read", agent: { id: "agt_test", displayName: "Test Agent", role: "developer", externalIdentities: [] }, scopes: ["tasks:read"] }, "idemp_read");

  const server = createServer({
    store: eventStore,
    intakeAdapter: null,
    authStore,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/github/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${readKey.apiKey}`,
      },
      body: JSON.stringify({}),
    });

    assert.strictEqual(res.status, 403);
    const json = await res.json();
    assert.strictEqual(json.error.code, "insufficient_scope");
  } finally {
    server.close();
  }
});

test("POST /providers/linear/intake creates a Linear-backed task and returns 201", async () => {
  const now = () => new Date("2026-05-06T18:00:00Z");
  const { eventStore, taskQueue, authStore, server } = createTestServer({
    now,
    adapterKey: "linearIntakeAdapter",
    createAdapter: (queue) => new LinearIssueSourceAdapter({ taskQueue: queue, now }),
    withAuth: true,
  });
  const { data: testKey } = authStore.createKey({ name: "test", agent: { id: "agt_test", displayName: "Test Agent", role: "developer", externalIdentities: [] }, scopes: ["tasks:write", "tasks:read"] }, "idemp_linear_test");
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/linear/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${testKey.apiKey}`,
        "idempotency-key": "idemp_01LINEARINTAKE",
      },
      body: JSON.stringify({
        id: "lin_issue_endpoint",
        identifier: "ENG-500",
        url: "https://linear.app/agentrail/issue/ENG-500/endpoint",
        title: "Linear endpoint intake",
        description: "## Acceptance Criteria\n- [ ] Endpoint returns 201",
        priorityLabel: "High",
        state: { id: "state_backlog", name: "Backlog", type: "backlog" },
        team: { id: "team_01", key: "ENG", name: "Engineering" },
        assignee: { id: "agt_test", name: "Test Agent" },
        workspace: { id: "workspace_01", urlKey: "agentrail" },
      }),
    });

    const bodyText = await res.text();
    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);
    const json = JSON.parse(bodyText);
    assert.strictEqual(json.data.identifier, "linear:agentrail:issues/ENG-500");
    assert.strictEqual(json.data.status, "todo");
    assert.deepStrictEqual(json.availableActions, ["get_task"]);

    const stored = taskQueue.getRawTask(json.data.taskId);
    assert.ok(stored);
    assert.strictEqual(stored.title, "Linear endpoint intake");
  } finally {
    server.close();
  }
});

test("POST /providers/linear/import imports a Linear issue by identifier", async () => {
  const now = () => new Date("2026-05-06T18:00:00Z");
  const { eventStore, taskQueue, authStore, server } = createTestServer({
    now,
    adapterKey: "linearIntakeAdapter",
    createAdapter: (queue) => new LinearIssueSourceAdapter({
      taskQueue: queue,
      now,
      linearApiKey: "lin_api_key_test",
      fetch: async (url, options) => {
        assert.strictEqual(String(url), "https://api.linear.app/graphql");
        assert.strictEqual(options?.method, "POST");
        assert.strictEqual(options?.headers?.authorization, "lin_api_key_test");
        assert.strictEqual(options?.headers?.["content-type"], "application/json");
        const body = JSON.parse(String(options?.body ?? "{}"));
        assert.strictEqual(body?.variables?.id, "ENG-777");
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "lin_issue_imported",
              identifier: "ENG-777",
              url: "https://linear.app/agentrail/issue/ENG-777/imported",
              title: "Imported from Linear API",
              description: "Imported through /providers/linear/import",
              state: { id: "state_backlog", name: "Backlog", type: "backlog" },
              team: { id: "team_01", key: "ENG", name: "Engineering" },
              assignee: { id: "user_01", name: "API Importer" },
              organization: { id: "workspace_01", urlKey: "agentrail" },
              labels: { nodes: [{ name: "imported" }] },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
    withAuth: true,
  });
  const { data: testKey } = authStore.createKey({ name: "test", agent: { id: "agt_test", displayName: "Test Agent", role: "developer", externalIdentities: [] }, scopes: ["tasks:write", "tasks:read"] }, "idemp_linear_import");
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/linear/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${testKey.apiKey}`,
        "idempotency-key": "idemp_01LINEARIMPORT",
      },
      body: JSON.stringify({ selector: "ENG-777" }),
    });

    const bodyText = await res.text();
    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${bodyText}`);
    const json = JSON.parse(bodyText);
    assert.strictEqual(json.data.identifier, "linear:agentrail:issues/ENG-777");
    assert.strictEqual(json.data.linearIssueId, "lin_issue_imported");

    const stored = taskQueue.getRawTask(json.data.taskId);
    assert.ok(stored);
    assert.strictEqual(stored.title, "Imported from Linear API");
  } finally {
    server.close();
  }
});

test("POST /providers/linear/webhooks verifies signature and ingests Issue events", async () => {
  const now = () => new Date("2026-05-06T18:00:00Z");
  const { eventStore, taskQueue, server } = createTestServer({
    now,
    adapterKey: "linearIntakeAdapter",
    createAdapter: (queue) => new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: "linear-secret", now }),
  });
  const webhookSecret = "linear-secret";
  const baseUrl = await listen(server);
  const payload = {
    action: "create",
    type: "Issue",
    createdAt: now().toISOString(),
    webhookTimestamp: now().getTime(),
    data: {
      id: "lin_issue_webhook",
      identifier: "ENG-501",
      url: "https://linear.app/agentrail/issue/ENG-501/webhook",
      title: "Linear webhook intake",
      state: { id: "state_started", name: "Started", type: "started" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    },
  };
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  try {
    const res = await fetch(`${baseUrl}/providers/linear/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": "linear-delivery-endpoint",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
      body: rawBody,
    });

    const bodyText = await res.text();
    assert.strictEqual(res.status, 202, `Expected 202, got ${res.status}: ${bodyText}`);
    const json = JSON.parse(bodyText);
    assert.strictEqual(json.data.ignored, false);
    assert.strictEqual(json.data.deliveryId, "linear-delivery-endpoint");
    assert.strictEqual(json.data.matchedTasks.length, 1);

    const stored = taskQueue.getRawTask(json.data.matchedTasks[0]);
    assert.strictEqual(stored?.identifier, "linear:agentrail:issues/ENG-501");
    assert.strictEqual(stored?.status, "in_progress");
  } finally {
    server.close();
  }
});

test("POST /providers/linear/webhooks rejects invalid signatures", async () => {
  const now = () => new Date("2026-05-06T18:00:00Z");
  const { server } = createTestServer({
    now,
    adapterKey: "linearIntakeAdapter",
    createAdapter: (queue) => new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: "linear-secret", now }),
  });

  const baseUrl = await listen(server);
  const payload = {
    action: "create",
    type: "Issue",
    createdAt: now().toISOString(),
    webhookTimestamp: now().getTime(),
    data: {
      id: "lin_issue_webhook_bad_sig",
      identifier: "ENG-502",
      url: "https://linear.app/agentrail/issue/ENG-502/webhook",
      title: "Linear webhook invalid signature",
      state: { id: "state_started", name: "Started", type: "started" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    },
  };

  try {
    const res = await fetch(`${baseUrl}/providers/linear/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-delivery": "linear-delivery-bad-signature",
        "linear-event": "Issue",
        "linear-signature": "bad_signature",
      },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

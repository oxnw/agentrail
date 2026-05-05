// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { AgentAuthStore } from "../src/agent-auth-store.js";
import { AgentTaskQueue } from "../src/agent-task-queue.js";
import { GitHubIssueIntakeAdapter } from "../src/github-issue-intake-adapter.js";
import { TaskEventStore } from "../src/task-event-store.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { address, port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return `http://${address}:${port}`;
}

test("POST /providers/github/intake creates a task and returns 201", async () => {
  const now = () => new Date("2026-05-05T12:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const intakeAdapter = new GitHubIssueIntakeAdapter({ taskQueue });

  const authStore = new AgentAuthStore({ now });
  const { data: testKey } = authStore.createKey({ name: "test", agentId: "agt_test", scopes: ["tasks:write", "tasks:read"], role: "developer" }, "idemp_test");

  const server = createServer({
    store: eventStore,
    intakeAdapter,
    authStore,
    now,
  });

  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/providers/github/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${testKey.key}`,
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

    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${await res.text()}`);
    const json = await res.json();
    assert.ok(json.data.taskId.startsWith("tsk_"));
    assert.strictEqual(json.data.identifier, "github:oxnw/agentrail:issues/42");
    assert.strictEqual(json.data.status, "todo");
    assert.deepStrictEqual(json.availableActions, ["get_task"]);

    // Verify the created task is later reachable via GET /tasks/{id} (if agent is assigned)
    const getRes = await fetch(`${baseUrl}/tasks/${json.data.taskId}`, {
      headers: {
        authorization: `Bearer ${testKey.key}`,
      },
    });
    assert.strictEqual(getRes.status, 200);
    const task = await getRes.json();
    assert.strictEqual(task.data.title, "E2E intake test issue");
  } finally {
    server.close();
  }
});

test("POST /providers/github/intake returns 404 when intake adapter is missing", async () => {
  const eventStore = new TaskEventStore({ now: () => new Date() });
  const authStore = new AgentAuthStore({ now: () => new Date() });
  const { data: writeKey } = authStore.createKey({ name: "write", agentId: "agt_test", scopes: ["tasks:write"], role: "developer" }, "idemp_write");

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
        authorization: `Bearer ${writeKey.key}`,
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
  const { data: readKey } = authStore.createKey({ name: "read", agentId: "agt_test", scopes: ["tasks:read"], role: "developer" }, "idemp_read");

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
        authorization: `Bearer ${readKey.key}`,
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

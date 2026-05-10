import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

function createAgentKey(authStore, agentId, scopes = ["tasks:read", "tasks:write"]) {
  return authStore.createKey({
    agent: {
      id: agentId,
      displayName: agentId,
      role: "agent",
    },
    scopes,
  }, `key:${agentId}`).data.apiKey;
}

function createTodoTask(taskQueue, agentId = "agt_alice") {
  return taskQueue.createTask({
    identifier: `AGEA-START-${agentId}`,
    title: "Startable task",
    assignee: { id: agentId, name: agentId },
    assigneeAgentId: agentId,
    status: "todo",
    availableActions: ["start"],
  });
}

test("POST /tasks/{id}/start starts an assigned todo task", async (t) => {
  const now = () => new Date("2026-05-09T10:00:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createTodoTask(taskQueue);
  const apiKey = createAgentKey(authStore, "agt_alice");
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    authStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const result = await requestJson(baseUrl, `/tasks/${task.id}/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "start-1",
    },
    body: JSON.stringify({}),
  });

  assert.equal(result.response.status, 202);
  assert.equal(result.body.data.status, "in_progress");
  assert.deepEqual(result.body.data.availableActions, ["submit"]);

  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored?.status, "in_progress");
  assert.deepEqual(stored?.availableActions, ["submit"]);

  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0].type, "task.updated");
  assert.equal(eventStore.events[0].data.previousStatus, "todo");
  assert.deepEqual(eventStore.events[0].data.availableActions, ["submit"]);
});

test("POST /tasks/{id}/start is idempotent with the same key and payload", async (t) => {
  const now = () => new Date("2026-05-09T10:10:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createTodoTask(taskQueue);
  const apiKey = createAgentKey(authStore, "agt_alice");
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    authStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const options = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "start-idem",
    },
    body: JSON.stringify({}),
  };

  const first = await requestJson(baseUrl, `/tasks/${task.id}/start`, options);
  const second = await requestJson(baseUrl, `/tasks/${task.id}/start`, options);

  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);
  assert.deepEqual(first.body, second.body);
  assert.equal(eventStore.events.length, 1);
});

test("AgentTaskQueue rolls back start updates when event append fails", async () => {
  const now = () => new Date("2026-05-09T10:15:00Z");
  const taskQueue = new AgentTaskQueue({
    now,
    eventStore: {
      append: async () => {
        throw new Error("event append failed");
      },
    },
  });
  const task = createTodoTask(taskQueue);

  await assert.rejects(
    taskQueue.startTask(task.id, {}, "start-event-failure", "agt_alice"),
    /event append failed/,
  );

  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored?.status, "todo");
  assert.deepEqual(stored?.availableActions, ["start"]);
});

test("POST /tasks/{id}/start rejects tasks assigned to another agent", async (t) => {
  const now = () => new Date("2026-05-09T10:20:00Z");
  const authStore = new AgentAuthStore({ now });
  const taskQueue = new AgentTaskQueue({ now });
  const task = createTodoTask(taskQueue, "agt_bob");
  const apiKey = createAgentKey(authStore, "agt_alice");
  const server = createServer({
    store: new TaskEventStore({ now }),
    taskLifecycleStore: taskQueue,
    authStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const result = await requestJson(baseUrl, `/tasks/${task.id}/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "start-forbidden",
    },
    body: JSON.stringify({}),
  });

  assert.equal(result.response.status, 403);
  assert.equal(result.body.error.code, "forbidden");
  assert.match(result.body.error.message, /not assigned to this agent/i);
});

test("POST /tasks/{id}/start rejects non-startable tasks", async (t) => {
  const now = () => new Date("2026-05-09T10:30:00Z");
  const authStore = new AgentAuthStore({ now });
  const taskQueue = new AgentTaskQueue({ now });
  const task = taskQueue.createTask({
    identifier: "AGEA-START-ACTIVE",
    title: "Already active",
    assignee: { id: "agt_alice", name: "Alice" },
    assigneeAgentId: "agt_alice",
    status: "in_progress",
    availableActions: ["submit"],
  });
  const apiKey = createAgentKey(authStore, "agt_alice");
  const server = createServer({
    store: new TaskEventStore({ now }),
    taskLifecycleStore: taskQueue,
    authStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const result = await requestJson(baseUrl, `/tasks/${task.id}/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "start-conflict",
    },
    body: JSON.stringify({}),
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "conflict");
  assert.match(result.body.error.message, /not in a startable state/i);
});

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

function createInProgressTask(taskQueue, agentId = "agt_alice") {
  return taskQueue.createTask({
    identifier: `AGEA-BLOCK-${agentId}`,
    title: "Blockable task",
    assignee: { id: agentId, name: agentId },
    assigneeAgentId: agentId,
    status: "in_progress",
    availableActions: ["submit"],
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

test("POST /tasks/{id}/blocker records blocker metadata and returns blocked task detail", async (t) => {
  const now = () => new Date("2026-05-09T10:40:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createInProgressTask(taskQueue);
  const apiKey = createAgentKey(authStore, "agt_alice");
  const notifications = [];
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    authStore,
    now,
    awaitingUserNotifier: async (notification) => {
      notifications.push(notification);
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const blockerRequest = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-create-1",
    },
    body: JSON.stringify({
      sourceRunId: "run_user_needed_1",
      sourceAgentId: "agt_alice",
      reason: "Need deployment target.",
      actionRequired: "Choose staging or production.",
      resumeInstructions: "Resume once the target is confirmed.",
    }),
  };
  const result = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, blockerRequest);

  assert.equal(result.response.status, 202);
  assert.equal(result.body.data.status, "blocked");
  assert.deepEqual(result.body.data.availableActions, ["resolve_blocker"]);
  assert.deepEqual(result.body.availableActions, ["resolve_blocker"]);
  assert.deepEqual(result.body.data.blocker, {
    kind: "awaiting_user",
    sourceRunId: "run_user_needed_1",
    sourceAgentId: "agt_alice",
    reason: "Need deployment target.",
    actionRequired: "Choose staging or production.",
    resumeInstructions: "Resume once the target is confirmed.",
    createdAt: "2026-05-09T10:40:00.000Z",
  });

  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored?.status, "blocked");
  assert.deepEqual(stored?.availableActions, ["resolve_blocker"]);
  assert.deepEqual(stored?.blocker, result.body.data.blocker);

  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0].type, "task.updated");
  assert.deepEqual(eventStore.events[0].data.changedFields, ["status", "availableActions", "blocker", "updatedAt"]);
  assert.deepEqual(notifications, [{
    runId: "run_user_needed_1",
    taskId: task.id,
    taskIdentifier: task.identifier,
    reason: "Need deployment target.",
    actionRequired: "Choose staging or production.",
    resumeInstructions: "Resume once the target is confirmed.",
  }]);

  const replay = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, blockerRequest);
  assert.equal(replay.response.status, 202);
  assert.deepEqual(replay.body, result.body);
  assert.equal(notifications.length, 1);
});

test("POST /tasks/{id}/resolve-blocker clears blocker and returns todo start action", async (t) => {
  const now = () => new Date("2026-05-09T10:50:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createInProgressTask(taskQueue);
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
  await requestJson(baseUrl, `/tasks/${task.id}/blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-create-2",
    },
    body: JSON.stringify({
      sourceRunId: "run_user_needed_2",
      sourceAgentId: "agt_alice",
      reason: "Need input.",
      actionRequired: "Provide a decision.",
      resumeInstructions: "Continue implementation.",
    }),
  });

  const result = await requestJson(baseUrl, `/tasks/${task.id}/resolve-blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-resolve-1",
    },
    body: JSON.stringify({
      resolutionSummary: "User chose staging.",
    }),
  });

  assert.equal(result.response.status, 202);
  assert.equal(result.body.data.status, "todo");
  assert.deepEqual(result.body.data.availableActions, ["start"]);
  assert.equal(result.body.data.blocker, null);
  assert.deepEqual(result.body.availableActions, ["start"]);
});

test("POST /tasks/{id}/blocker requires Idempotency-Key", async (t) => {
  const now = () => new Date("2026-05-09T11:00:00Z");
  const authStore = new AgentAuthStore({ now });
  const taskQueue = new AgentTaskQueue({ now });
  const task = createInProgressTask(taskQueue);
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
  const result = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      sourceRunId: "run_missing_key",
      sourceAgentId: "agt_alice",
      reason: "Need input.",
      actionRequired: "Provide input.",
      resumeInstructions: "Resume.",
    }),
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "validation_error");
  assert.match(result.body.error.message, /Idempotency-Key/i);
});

test("POST /tasks/{id}/blocker requires sourceAgentId", async (t) => {
  const now = () => new Date("2026-05-09T11:05:00Z");
  const authStore = new AgentAuthStore({ now });
  const taskQueue = new AgentTaskQueue({ now });
  const task = createInProgressTask(taskQueue);
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
  const result = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-missing-source-agent",
    },
    body: JSON.stringify({
      sourceRunId: "run_missing_source_agent",
      reason: "Need input.",
      actionRequired: "Provide input.",
      resumeInstructions: "Resume.",
    }),
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "validation_error");
  assert.match(result.body.error.message, /sourceAgentId/);
});

test("AgentTaskQueue rejects awaiting-user blockers for review and terminal tasks", async () => {
  const now = () => new Date("2026-05-09T11:07:00Z");
  const taskQueue = new AgentTaskQueue({ now });

  for (const status of ["in_review", "done", "cancelled"]) {
    const task = taskQueue.createTask({
      identifier: `AGEA-BLOCK-STALE-${status}`,
      title: `Stale ${status} task`,
      assignee: { id: "agt_alice", name: "Alice" },
      assigneeAgentId: "agt_alice",
      status,
      availableActions: [],
    });

    await assert.rejects(
      taskQueue.blockTaskAwaitingUser(task.id, {
        sourceRunId: `run_stale_${status}`,
        sourceAgentId: "agt_alice",
        reason: "Stale report.",
        actionRequired: "Ignore stale report.",
        resumeInstructions: "No resume needed.",
      }, `block-stale-${status}`, "agt_alice"),
      (error) => error instanceof Error
        && "statusCode" in error
        && error.statusCode === 409
        && /blockable state/i.test(error.message),
    );
    assert.equal(taskQueue.getRawTask(task.id)?.status, status);
  }
});

test("POST /tasks/{id}/resolve-blocker rejects non-blocked tasks", async (t) => {
  const now = () => new Date("2026-05-09T11:10:00Z");
  const authStore = new AgentAuthStore({ now });
  const taskQueue = new AgentTaskQueue({ now });
  const task = createInProgressTask(taskQueue);
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
  const result = await requestJson(baseUrl, `/tasks/${task.id}/resolve-blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-resolve-conflict",
    },
    body: JSON.stringify({
      resolutionSummary: "Nothing to resolve.",
    }),
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "conflict");
});

test("POST /tasks/{id}/resolve-blocker requires Idempotency-Key", async (t) => {
  const now = () => new Date("2026-05-09T11:15:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createInProgressTask(taskQueue);
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
  await requestJson(baseUrl, `/tasks/${task.id}/blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-before-missing-resolve-key",
    },
    body: JSON.stringify({
      sourceRunId: "run_user_needed_missing_resolve_key",
      sourceAgentId: "agt_alice",
      reason: "Need input.",
      actionRequired: "Provide input.",
      resumeInstructions: "Resume after input.",
    }),
  });

  const result = await requestJson(baseUrl, `/tasks/${task.id}/resolve-blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      resolutionSummary: "Input provided.",
    }),
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "validation_error");
  assert.match(result.body.error.message, /Idempotency-Key/i);
});

test("POST /tasks/{id}/blocker is idempotent with the same key and payload", async (t) => {
  const now = () => new Date("2026-05-09T11:20:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createInProgressTask(taskQueue);
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
      "idempotency-key": "blocker-idem",
    },
    body: JSON.stringify({
      sourceRunId: "run_user_needed_3",
      sourceAgentId: "agt_alice",
      reason: "Need approval.",
      actionRequired: "Approve the change.",
      resumeInstructions: "Ship after approval.",
    }),
  };

  const first = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, options);
  // Change task state before the second /tasks/${task.id}/blocker request to verify
  // requestJson returns the cached idempotent response instead of re-running logic.
  taskQueue.updateTask(task.id, {
    assignee: { id: "agt_bob", name: "Bob" },
    assigneeAgentId: "agt_bob",
  });
  const second = await requestJson(baseUrl, `/tasks/${task.id}/blocker`, options);

  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);
  assert.deepEqual(first.body, second.body);
  assert.equal(eventStore.events.length, 1);
});

test("POST /tasks/{id}/resolve-blocker is idempotent with the same key and payload", async (t) => {
  const now = () => new Date("2026-05-09T11:30:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = createInProgressTask(taskQueue);
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
  await requestJson(baseUrl, `/tasks/${task.id}/blocker`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "blocker-before-resolve-idem",
    },
    body: JSON.stringify({
      sourceRunId: "run_user_needed_4",
      sourceAgentId: "agt_alice",
      reason: "Need approval.",
      actionRequired: "Approve the change.",
      resumeInstructions: "Ship after approval.",
    }),
  });

  const options = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "resolve-idem",
    },
    body: JSON.stringify({
      resolutionSummary: "Approved.",
    }),
  };

  const first = await requestJson(baseUrl, `/tasks/${task.id}/resolve-blocker`, options);
  const second = await requestJson(baseUrl, `/tasks/${task.id}/resolve-blocker`, options);

  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);
  assert.deepEqual(first.body, second.body);
  assert.equal(eventStore.events.length, 2);
});

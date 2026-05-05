import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { AgentAuthStore } from "../src/agent-auth-store.js";
import { AgentTaskQueue } from "../src/agent-task-queue.js";
import { TaskEventStore } from "../src/task-event-store.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test("bootstrap creates admin key without authentication", async (t) => {
  const now = new Date("2026-05-01T05:00:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const server = createServer({
    store: new TaskEventStore(),
    authStore,
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  // First request should succeed (bootstrap)
  const bootstrapResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "bootstrap-test-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_admin", displayName: "Admin", role: "admin" },
      scopes: ["auth:admin"]
    })
  });

  assert.equal(bootstrapResponse.status, 201);
  const bootstrapBody = await bootstrapResponse.json();
  assert.equal(bootstrapBody.data.agent.id, "agt_admin");
  assert.deepEqual(bootstrapBody.data.scopes, ["auth:admin"]);

  // Second bootstrap should fail (no longer in bootstrap mode)
  const secondBootstrap = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "bootstrap-test-v2"
    },
    body: JSON.stringify({
      agent: { id: "agt_admin2", displayName: "Admin 2", role: "admin" },
      scopes: ["auth:admin"]
    })
  });

  assert.equal(secondBootstrap.status, 401);
  const secondBody = await secondBootstrap.json();
  assert.equal(secondBody.error.code, "unauthorized");
});

test("cross-agent task isolation enforces visibility rules", async (t) => {
  const now = new Date("2026-05-01T05:10:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const eventStore = new TaskEventStore();
  const taskQueue = new AgentTaskQueue({ now: () => now, eventStore });

  // Create tasks for two different agents
  const aliceTask = taskQueue.createTask({
    identifier: "AGEA-100-A",
    title: "Alice's task",
    assignee: { id: "agt_alice", name: "Alice" },
    status: "in_progress",
    availableActions: ["submit"]
  });

  const bobTask = taskQueue.createTask({
    identifier: "AGEA-100-B",
    title: "Bob's task",
    assignee: { id: "agt_bob", name: "Bob" },
    status: "in_progress",
    availableActions: ["submit"]
  });

  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    authStore,
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  // Bootstrap admin
  const adminResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "admin-bootstrap-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_admin", displayName: "Admin", role: "admin" },
      scopes: ["auth:admin", "tasks:read"]
    })
  });
  assert.equal(adminResponse.status, 201);
  const adminKeyBody = await adminResponse.json();
  const adminKey = adminKeyBody.data.apiKey;

  // Create Alice's API key
  const aliceKeyResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "alice-key-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_alice", displayName: "Alice", role: "agent" },
      scopes: ["tasks:read"]
    })
  });
  assert.equal(aliceKeyResponse.status, 201);
  const aliceApiKey = (await aliceKeyResponse.json()).data.apiKey;

  // Create Bob's API key
  const bobKeyResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "bob-key-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_bob", displayName: "Bob", role: "agent" },
      scopes: ["tasks:read"]
    })
  });
  assert.equal(bobKeyResponse.status, 201);
  const bobApiKey = (await bobKeyResponse.json()).data.apiKey;

  // Alice should only see her own tasks
  const aliceMine = await fetch(`${baseUrl}/tasks/mine`, {
    headers: { authorization: `Bearer ${aliceApiKey}` }
  });
  assert.equal(aliceMine.status, 200);
  const aliceTasks = await aliceMine.json();
  assert.equal(aliceTasks.data.length, 1);
  assert.equal(aliceTasks.data[0].id, aliceTask.id);

  // Bob should only see his own tasks
  const bobMine = await fetch(`${baseUrl}/tasks/mine`, {
    headers: { authorization: `Bearer ${bobApiKey}` }
  });
  assert.equal(bobMine.status, 200);
  const bobTasks = await bobMine.json();
  assert.equal(bobTasks.data.length, 1);
  assert.equal(bobTasks.data[0].id, bobTask.id);

  // Alice should be able to read her own task
  const aliceDetail = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
    headers: { authorization: `Bearer ${aliceApiKey}` }
  });
  assert.equal(aliceDetail.status, 200);
  const aliceDetailBody = await aliceDetail.json();
  assert.equal(aliceDetailBody.data.id, aliceTask.id);

  // Bob should be able to read his own task
  const bobDetail = await fetch(`${baseUrl}/tasks/${bobTask.id}`, {
    headers: { authorization: `Bearer ${bobApiKey}` }
  });
  assert.equal(bobDetail.status, 200);

  // Alice should NOT be able to read Bob's task
  const aliceAccessBob = await fetch(`${baseUrl}/tasks/${bobTask.id}`, {
    headers: { authorization: `Bearer ${aliceApiKey}` }
  });
  assert.equal(aliceAccessBob.status, 403);
  const aliceAccessBobBody = await aliceAccessBob.json();
  assert.equal(aliceAccessBobBody.error.code, "forbidden");
  assert.equal(aliceAccessBobBody.error.message, "Task is not visible to you.");

  // Bob should NOT be able to read Alice's task
  const bobAccessAlice = await fetch(`${baseUrl}/tasks/${aliceTask.id}`, {
    headers: { authorization: `Bearer ${bobApiKey}` }
  });
  assert.equal(bobAccessAlice.status, 403);
  const bobAccessAliceBody = await bobAccessAlice.json();
  assert.equal(bobAccessAliceBody.error.code, "forbidden");
});

test("unauthenticated requests to protected routes return 401", async (t) => {
  const now = new Date("2026-05-01T05:20:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const taskQueue = new AgentTaskQueue({ now: () => now });

  const task = taskQueue.createTask({
    identifier: "AGEA-100-C",
    title: "Protected task",
    assignee: { id: "agt_test", name: "Test" },
    status: "in_progress"
  });

  const server = createServer({
    store: new TaskEventStore(),
    taskLifecycleStore: taskQueue,
    authStore,
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  // No auth header
  const noAuth = await fetch(`${baseUrl}/tasks/mine`);
  assert.equal(noAuth.status, 401);
  const noAuthBody = await noAuth.json();
  assert.equal(noAuthBody.error.code, "unauthorized");

  // Invalid auth header
  const badAuth = await fetch(`${baseUrl}/tasks/mine`, {
    headers: { authorization: "Bearer invalid_key" }
  });
  assert.equal(badAuth.status, 401);
  const badAuthBody = await badAuth.json();
  assert.equal(badAuthBody.error.code, "unauthorized");

  // No auth for task detail
  const noAuthDetail = await fetch(`${baseUrl}/tasks/${task.id}`);
  assert.equal(noAuthDetail.status, 401);

  // No auth for submit
  const noAuthSubmit = await fetch(`${baseUrl}/tasks/${task.id}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "test" })
  });
  assert.equal(noAuthSubmit.status, 401);
});

test("scoped write access controls task submission", async (t) => {
  const now = new Date("2026-05-01T05:30:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const taskQueue = new AgentTaskQueue({ now: () => now });

  const task = taskQueue.createTask({
    identifier: "AGEA-100-D",
    title: "Write test task",
    assignee: { id: "agt_writer", name: "Writer" },
    status: "in_progress",
    availableActions: ["submit"]
  });

  const server = createServer({
    store: new TaskEventStore(),
    taskLifecycleStore: taskQueue,
    authStore,
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  // Bootstrap admin
  const adminResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "admin-bootstrap-write"
    },
    body: JSON.stringify({
      agent: { id: "agt_admin", displayName: "Admin", role: "admin" },
      scopes: ["auth:admin"]
    })
  });
  const adminKey = (await adminResponse.json()).data.apiKey;

  // Create reader-only key
  const readerResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "reader-key-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_reader", displayName: "Reader", role: "agent" },
      scopes: ["tasks:read"]
    })
  });
  const readerKey = (await readerResponse.json()).data.apiKey;

  // Reader should NOT be able to submit
  const readerSubmit = await fetch(`${baseUrl}/tasks/${task.id}/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readerKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "reader-submit-v1"
    },
    body: JSON.stringify({ summary: "test submission" })
  });
  assert.equal(readerSubmit.status, 403);
  const readerSubmitBody = await readerSubmit.json();
  assert.equal(readerSubmitBody.error.code, "insufficient_scope");
  assert.equal(readerSubmitBody.error.details.requiredScope, "tasks:write");

  // Create writer key
  const writerResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "writer-key-v1"
    },
    body: JSON.stringify({
      agent: { id: "agt_writer", displayName: "Writer", role: "agent" },
      scopes: ["tasks:read", "tasks:write"]
    })
  });
  const writerKey = (await writerResponse.json()).data.apiKey;

  // Writer should be able to submit (though it returns 501 since no delegate)
  const writerSubmit = await fetch(`${baseUrl}/tasks/${task.id}/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writerKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "writer-submit-v1"
    },
    body: JSON.stringify({ summary: "test submission" })
  });
  // 501 because no delegate is configured, but auth passed
  assert.equal(writerSubmit.status, 501);
});

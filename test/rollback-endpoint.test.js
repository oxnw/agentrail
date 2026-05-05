import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.ts";
import { createAgentShipCycleDemoStore, DEMO_HEAD_SHA } from "./helpers/deterministic-lifecycle-store.ts";
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
      ...options.headers
    }
  });
  const body = await response.json();
  return { response, body };
}

async function shipDemoTask(baseUrl) {
  await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/submit", {
    method: "POST",
    headers: { "idempotency-key": "submit-1" },
    body: JSON.stringify({
      summary: "First submission",
      artifacts: [{ type: "pull_request", url: "https://github.com/example/pr/1" }]
    })
  });

  await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/submit", {
    method: "POST",
    headers: { "idempotency-key": "submit-2" },
    body: JSON.stringify({
      summary: "Fixed idempotency",
      artifacts: [{ type: "pull_request", url: "https://github.com/example/pr/1" }],
      checks: [{ name: "unit-tests", status: "passed" }]
    })
  });

  await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/ship", {
    method: "POST",
    headers: { "idempotency-key": "ship-1" },
    body: JSON.stringify({
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha: DEMO_HEAD_SHA
    })
  });
}

function createTestServer() {
  const now = () => new Date("2026-05-01T10:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskLifecycleStore = createAgentShipCycleDemoStore({ now, eventStore });
  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    ciStatusAdapter: taskLifecycleStore,
    reviewFeedbackAdapter: taskLifecycleStore,
    now
  });
  return { server, taskLifecycleStore, eventStore };
}

test("POST /tasks/{id}/rollback returns 202 with rollback PR details after ship", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);

  const result = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-1" },
    body: JSON.stringify({ reason: "Production regression detected" })
  });

  assert.equal(result.response.status, 202);
  assert.equal(result.body.data.taskId, "tsk_DEMOISSUETOSHIP01");
  assert.equal(result.body.data.status, "rollback_pr_created");
  assert.ok(result.body.data.rollbackPrUrl);
  assert.ok(result.body.data.newHeadSha);
  assert.equal(result.body.data.revertedCommitSha, DEMO_HEAD_SHA);
  assert.ok(result.body.data.rollbackPrNumber);
});

test("POST /tasks/{id}/rollback rejects task that is not in shipped state", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  const result = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-notshipped" },
    body: JSON.stringify({ reason: "Testing" })
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "conflict");
  assert.match(result.body.error.message, /not in a shipped state/);
});

test("POST /tasks/{id}/rollback requires Idempotency-Key", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);

  const result = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    body: JSON.stringify({ reason: "Testing" })
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "validation_error");
});

test("POST /tasks/{id}/rollback is idempotent with same key and payload", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);

  const payload = JSON.stringify({ reason: "Rollback needed" });
  const opts = {
    method: "POST",
    headers: { "idempotency-key": "rollback-idem" },
    body: payload
  };

  const first = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", opts);
  const second = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", opts);

  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);
  assert.deepEqual(first.body, second.body);
});

test("POST /tasks/{id}/rollback rejects reused key with different payload", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);

  await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-conflict" },
    body: JSON.stringify({ reason: "First reason" })
  });

  const second = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-conflict" },
    body: JSON.stringify({ reason: "Different reason" })
  });

  assert.equal(second.response.status, 409);
  assert.equal(second.body.error.code, "conflict");
});

test("POST /tasks/{id}/rollback returns 404 for unknown task", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  const result = await requestJson(baseUrl, "/tasks/tsk_NONEXISTENT00001/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-404" },
    body: JSON.stringify({ reason: "Testing" })
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, "not_found");
});

test("POST /tasks/{id}/rollback emits task.rolled_back event", async (t) => {
  const { server, eventStore } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);
  const seqBefore = eventStore.getMaxSequence();

  await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/rollback", {
    method: "POST",
    headers: { "idempotency-key": "rollback-event" },
    body: JSON.stringify({ reason: "Event check" })
  });

  const events = eventStore.getEventsAfter(seqBefore);
  const rollbackEvent = events.find((e) => e.type === "task.rolled_back");
  assert.ok(rollbackEvent, "Expected a task.rolled_back event");
  assert.equal(rollbackEvent.data.taskId, "tsk_DEMOISSUETOSHIP01");
  assert.equal(rollbackEvent.data.status, "rolled_back");
  assert.ok(rollbackEvent.data.rollbackPrUrl);
  assert.ok(rollbackEvent.data.newHeadSha);
});

test("task shows rollback in availableActions after ship", async (t) => {
  const { server } = createTestServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const baseUrl = await listen(server);

  await shipDemoTask(baseUrl);

  const task = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01");
  assert.equal(task.response.status, 200);
  assert.ok(task.body.data.availableActions.includes("rollback"));
});

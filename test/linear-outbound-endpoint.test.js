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
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response (${response.status}): ${text || "(empty response)"}`);
  }
  return { response, body };
}

function createProvidersWriteKey(authStore) {
  return authStore.createKey({
    name: "linear-sync",
    agent: {
      id: "agt_linear_sync",
      displayName: "Linear Sync Agent",
      role: "provider_sync",
      externalIdentities: [{ provider: "linear", subject: "linear-sync" }],
    },
    scopes: ["providers:write"],
  }, "linear-sync-key-v1").data.apiKey;
}

function createTasksWriteKey(authStore) {
  return authStore.createKey({
    name: "task-writer",
    agent: {
      id: "agt_task_writer",
      displayName: "Task Writer",
      role: "developer",
      externalIdentities: [],
    },
    scopes: ["tasks:write"],
  }, "task-writer-key-v1").data.apiKey;
}

function createLinearTask(taskQueue) {
  return taskQueue.createTask({
    identifier: "linear:agentrail:issues/ENG-133",
    title: "Sync outbound Linear updates",
    description: "Push AgentRail-originated updates back to Linear.",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_linear_sync", name: "Linear Sync Agent" },
    assigneeAgentId: "agt_linear_sync",
    links: { issue: "https://linear.app/agentrail/issue/ENG-133/outbound-sync" },
    context: { project: "ENG", goal: "Linear outbound sync" },
    availableActions: ["submit"],
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_133",
      linearIdentifier: "ENG-133",
      workflowStateId: "lin_state_in_progress",
    },
  });
}

function createTestServer({ linearIssueSourceAdapter }) {
  const now = () => new Date("2026-05-06T19:00:00.000Z");
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const authStore = new AgentAuthStore({ now });
  const task = createLinearTask(taskQueue);
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    linearIssueSourceAdapter,
    authStore,
    now,
  });
  return { server, task, authStore, taskQueue };
}

test("POST /providers/linear/tasks/{taskId}/comments creates one Linear comment and replays idempotently", async (t) => {
  const calls = [];
  const linearIssueSourceAdapter = {
    async createComment(issueId, body) {
      calls.push({ issueId, body });
      return {
        data: {
          commentId: "lin_comment_133",
          commentUrl: "https://linear.app/agentrail/comment/lin_comment_133",
          success: true,
        },
        availableActions: ["get_task"],
      };
    },
  };
  const { server, task, authStore } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createProvidersWriteKey(authStore);
  const payload = JSON.stringify({ body: "AgentRail submitted the implementation PR." });
  const options = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-comment-133-v1",
    },
    body: payload,
  };

  const first = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/comments`, options);
  const second = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/comments`, options);

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(calls, [
    {
      issueId: "lin_issue_133",
      body: "AgentRail submitted the implementation PR.",
    },
  ]);
  assert.equal(first.body.data.taskId, task.id);
  assert.equal(first.body.data.linearIssueId, "lin_issue_133");
  assert.equal(first.body.data.commentId, "lin_comment_133");
  assert.equal(first.body.data.commentUrl, "https://linear.app/agentrail/comment/lin_comment_133");
  assert.deepEqual(first.body.availableActions, ["get_task"]);
});

test("POST /providers/linear/tasks/{taskId}/comments rejects a reused idempotency key with a different body", async (t) => {
  const calls = [];
  const linearIssueSourceAdapter = {
    async createComment(issueId, body) {
      calls.push({ issueId, body });
      return {
        data: { commentId: "lin_comment_133", commentUrl: null, success: true },
        availableActions: ["get_task"],
      };
    },
  };
  const { server, task, authStore } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createProvidersWriteKey(authStore);

  const first = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-comment-conflict",
    },
    body: JSON.stringify({ body: "First comment." }),
  });
  assert.equal(first.response.status, 201);
  const conflict = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-comment-conflict",
    },
    body: JSON.stringify({ body: "Different comment." }),
  });

  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "conflict");
  assert.match(conflict.body.error.message, /Idempotency-Key/);
  assert.equal(calls.length, 1);
});

test("POST /providers/linear/tasks/{taskId}/workflow-state syncs Linear and updates the AgentRail task state", async (t) => {
  const calls = [];
  const linearIssueSourceAdapter = {
    async updateIssueState(issueId, stateId) {
      calls.push({ issueId, stateId });
      return {
        data: {
          issueId,
          stateId,
          stateName: "Done",
          agentRailStatus: "done",
          success: true,
        },
        availableActions: ["get_task"],
      };
    },
  };
  const { server, task, authStore, taskQueue } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createProvidersWriteKey(authStore);

  const options = {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-state-133-v1",
    },
    body: JSON.stringify({ stateId: "lin_state_done" }),
  };

  const result = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, options);
  const replay = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, options);

  assert.equal(result.response.status, 200);
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, result.body);
  assert.deepEqual(calls, [{ issueId: "lin_issue_133", stateId: "lin_state_done" }]);
  assert.equal(result.body.data.taskId, task.id);
  assert.equal(result.body.data.linearIssueId, "lin_issue_133");
  assert.equal(result.body.data.stateId, "lin_state_done");
  assert.equal(result.body.data.stateName, "Done");
  assert.equal(result.body.data.agentRailStatus, "done");
  assert.deepEqual(result.body.data.availableActions, []);
  assert.deepEqual(result.body.availableActions, ["get_task"]);
  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored.status, "done");
  assert.deepEqual(stored.availableActions, []);
  assert.equal(stored.source.workflowStateId, "lin_state_done");
  assert.equal(stored.source.workflowStateName, "Done");
});

test("POST /providers/linear/tasks/{taskId}/workflow-state leaves the local task unchanged when Linear rejects the mutation", async (t) => {
  const calls = [];
  const linearIssueSourceAdapter = {
    async updateIssueState(issueId, stateId) {
      calls.push({ issueId, stateId });
      return {
        data: {
          issueId: null,
          stateId: null,
          stateName: null,
          success: false,
        },
        availableActions: ["get_task"],
      };
    },
  };
  const { server, task, authStore, taskQueue } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createProvidersWriteKey(authStore);

  const result = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-state-133-upstream-failure",
    },
    body: JSON.stringify({ stateId: "lin_state_done" }),
  });

  assert.equal(result.response.status, 502);
  assert.equal(result.body.error.code, "upstream_error");
  assert.deepEqual(calls, [{ issueId: "lin_issue_133", stateId: "lin_state_done" }]);
  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored.status, "in_progress");
  assert.deepEqual(stored.availableActions, ["submit"]);
  assert.equal(stored.source.workflowStateId, "lin_state_in_progress");
  assert.equal(stored.source.workflowStateName, undefined);
});

test("POST /providers/linear/tasks/{taskId}/workflow-state rejects reused idempotency key with different state", async (t) => {
  const calls = [];
  const linearIssueSourceAdapter = {
    async updateIssueState(issueId, stateId) {
      calls.push({ issueId, stateId });
      return {
        data: {
          issueId,
          stateId,
          stateName: "Done",
          agentRailStatus: "done",
          success: true,
        },
        availableActions: ["get_task"],
      };
    },
  };
  const { server, task, authStore } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createProvidersWriteKey(authStore);

  const first = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-state-conflict",
    },
    body: JSON.stringify({ stateId: "lin_state_done" }),
  });
  const conflict = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-state-conflict",
    },
    body: JSON.stringify({ stateId: "lin_state_review" }),
  });

  assert.equal(first.response.status, 200);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, "conflict");
  assert.match(conflict.body.error.message, /Idempotency-Key/);
  assert.deepEqual(calls, [{ issueId: "lin_issue_133", stateId: "lin_state_done" }]);
});

test("Linear outbound sync requires providers:write rather than broad task write scope", async (t) => {
  const linearIssueSourceAdapter = {
    async createComment() {
      throw new Error("adapter should not be called without providers:write");
    },
    async updateIssueState() {
      throw new Error("adapter should not be called without providers:write");
    },
  };
  const { server, task, authStore } = createTestServer({ linearIssueSourceAdapter });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const apiKey = createTasksWriteKey(authStore);

  const result = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/comments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-comment-forbidden",
    },
    body: JSON.stringify({ body: "No provider scope." }),
  });

  assert.equal(result.response.status, 403);
  assert.equal(result.body.error.code, "insufficient_scope");
  assert.equal(result.body.error.details.requiredScope, "providers:write");

  const workflowResult = await requestJson(baseUrl, `/providers/linear/tasks/${task.id}/workflow-state`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": "linear-state-forbidden",
    },
    body: JSON.stringify({ stateId: "lin_state_done" }),
  });

  assert.equal(workflowResult.response.status, 403);
  assert.equal(workflowResult.body.error.code, "insufficient_scope");
  assert.equal(workflowResult.body.error.details.requiredScope, "providers:write");
});

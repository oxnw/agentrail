import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentRunStore } from "../src/agent-run-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function createUsageKey(authStore) {
  return authStore.createKey({
    agent: {
      id: "agt_operator",
      displayName: "Operator",
      role: "operator",
    },
    scopes: ["usage:read"],
  }, "key:usage").data.apiKey;
}

function createRunnerKey(authStore, agentId = "agt_claudia") {
  return authStore.createKey({
    agent: {
      id: agentId,
      displayName: "Runner",
      role: "agent",
    },
    scopes: ["tasks:write"],
  }, `key:${agentId}`).data.apiKey;
}

function makeRun(runId, status = "running") {
  return {
    runId,
    agentId: "agt_claudia",
    runner: "codex",
    taskId: "tsk_123",
    taskIdentifier: "github:oxnw/agentrail:issues/21",
    status,
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    branchName: "agentrail/tsk_123",
    promptPath: "/tmp/prompt.md",
    logPath: "/tmp/run.log",
    handoffPath: null,
    createdAt: "2026-05-09T10:00:00.000Z",
    startedAt: "2026-05-09T10:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-09T10:00:01.000Z",
    exitCode: null,
    summary: null,
    launch: {
      executable: "codex",
      args: ["exec"],
    },
  };
}

test("GET /operator/agent-runs lists persisted runs", async (t) => {
  const now = () => new Date("2026-05-09T10:00:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_first", "running"));
  agentRunStore.createRun({
    ...makeRun("run_second", "failed"),
    taskId: "tsk_456",
    updatedAt: "2026-05-09T10:00:02.000Z",
  });
  const apiKey = createUsageKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/operator/agent-runs?agentId=agt_claudia&status=failed&limit=1`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].runId, "run_second");
  assert.deepEqual(body.availableActions, []);
});

test("GET /operator/agent-runs/{runId} returns a single run", async (t) => {
  const now = () => new Date("2026-05-09T10:10:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_single", "awaiting_user"));
  const apiKey = createUsageKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/operator/agent-runs/run_single`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.runId, "run_single");
  assert.equal(body.data.status, "awaiting_user");
});

test("GET /operator/agent-runs rejects excessive limit", async (t) => {
  const now = () => new Date("2026-05-09T10:15:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  const apiKey = createUsageKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/operator/agent-runs?limit=101`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /between 1 and 100/);
});

test("GET /operator/agent-runs rejects invalid status filters", async (t) => {
  const now = () => new Date("2026-05-09T10:16:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  const apiKey = createUsageKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/operator/agent-runs?status=done`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "validation_error");
  assert.match(body.error.message, /Invalid status filter/);
});

test("POST /agent-runs/{runId}/report records agent progress and reported handoff", async (t) => {
  const now = () => new Date("2026-05-09T10:20:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_report", "running"));
  const apiKey = createRunnerKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/agent-runs/run_report/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "completed",
      summary: "Committed the change and ready for AgentRail to publish.",
      handoff: {
        version: 1,
        target: "agentrail",
        summary: "Committed the change and ready for AgentRail to publish.",
        commitSha: "abc123",
      },
    }),
  });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.data.runId, "run_report");
  assert.equal(body.data.reports.length, 1);
  assert.equal(body.data.reportedHandoff.commitSha, "abc123");

  const progressResponse = await fetch(`${baseUrl}/agent-runs/run_report/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Continuing without changing handoff.",
    }),
  });

  assert.equal(progressResponse.status, 202);
  const progressBody = await progressResponse.json();
  assert.equal(progressBody.data.reports.length, 2);
  assert.equal(progressBody.data.reportedHandoff.commitSha, "abc123");

  const clearResponse = await fetch(`${baseUrl}/agent-runs/run_report/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Handoff resolved.",
      handoff: null,
    }),
  });

  assert.equal(clearResponse.status, 202);
  const clearBody = await clearResponse.json();
  assert.equal(clearBody.data.reports.length, 3);
  assert.equal(clearBody.data.reportedHandoff, null);
});

test("POST /agent-runs/{runId}/report blocks the linked task for user action", async (t) => {
  const now = () => new Date("2026-05-09T10:25:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = taskQueue.createTask({
    identifier: "AGEA-BLOCKER-REPORT",
    title: "Needs user input",
    assignee: { id: "agt_claudia", name: "Claudia" },
    assigneeAgentId: "agt_claudia",
    status: "in_progress",
    availableActions: ["submit"],
  });
  agentRunStore.createRun({
    ...makeRun("run_blocked_report", "running"),
    taskId: task.id,
  });
  const apiKey = createRunnerKey(authStore);
  const server = createServer({
    store: eventStore,
    authStore,
    agentRunStore,
    taskLifecycleStore: taskQueue,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/agent-runs/run_blocked_report/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Need repository credentials.",
      reason: "missing_credentials",
      actionRequired: "Reconnect GitHub.",
      resumeInstructions: "Retry the task after GitHub is connected.",
    }),
  });

  if (response.status !== 202) {
    assert.fail(await response.text());
  }
  const body = await response.json();
  assert.equal(body.data.status, "awaiting_user");
  assert.equal(body.data.userAction.reason, "missing_credentials");
  assert.equal(body.data.userAction.actionRequired, "Reconnect GitHub.");

  const blockedTask = taskQueue.getRawTask(task.id);
  assert.equal(blockedTask?.status, "blocked");
  assert.deepEqual(blockedTask?.availableActions, ["resolve_blocker"]);
  assert.deepEqual(blockedTask?.blocker, {
    kind: "awaiting_user",
    sourceRunId: "run_blocked_report",
    sourceAgentId: "agt_claudia",
    reason: "missing_credentials",
    actionRequired: "Reconnect GitHub.",
    resumeInstructions: "Retry the task after GitHub is connected.",
    createdAt: "2026-05-09T10:25:00.000Z",
  });
});

test("POST /agent-runs/{runId}/report requires task lifecycle blocking for blocked reports", async (t) => {
  const now = () => new Date("2026-05-09T10:27:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_blocked_without_tasks", "running"));
  const apiKey = createRunnerKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/agent-runs/run_blocked_without_tasks/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Need repository credentials.",
      reason: "missing_credentials",
      actionRequired: "Reconnect GitHub.",
      resumeInstructions: "Retry the task after GitHub is connected.",
    }),
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
  const run = agentRunStore.getRun("run_blocked_without_tasks");
  assert.equal(run?.status, "running");
  assert.equal(run?.reports.length, 0);
});

test("POST /agent-runs/{runId}/report does not persist blocked reports when task blocking fails", async (t) => {
  const now = () => new Date("2026-05-09T10:28:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = taskQueue.createTask({
    identifier: "AGEA-BLOCKER-STALE",
    title: "Already done",
    assignee: { id: "agt_claudia", name: "Claudia" },
    assigneeAgentId: "agt_claudia",
    status: "done",
    availableActions: [],
  });
  agentRunStore.createRun({
    ...makeRun("run_blocked_stale", "running"),
    taskId: task.id,
  });
  const apiKey = createRunnerKey(authStore);
  const server = createServer({
    store: eventStore,
    authStore,
    agentRunStore,
    taskLifecycleStore: taskQueue,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/agent-runs/run_blocked_stale/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Stale blocked report.",
      reason: "stale_report",
      actionRequired: "Ignore stale report.",
      resumeInstructions: "No resume required.",
    }),
  });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "conflict");
  assert.equal(agentRunStore.getRun("run_blocked_stale")?.status, "running");
  assert.equal(agentRunStore.getRun("run_blocked_stale")?.reports.length, 0);
  assert.equal(taskQueue.getRawTask(task.id)?.status, "done");
});

test("POST /agent-runs/{runId}/report rolls back task blocker when run persistence fails", async (t) => {
  const now = () => new Date("2026-05-09T10:29:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const backingRunStore = new AgentRunStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = taskQueue.createTask({
    identifier: "AGEA-BLOCKER-ROLLBACK",
    title: "Rollback blocker",
    assignee: { id: "agt_claudia", name: "Claudia" },
    assigneeAgentId: "agt_claudia",
    status: "in_progress",
    availableActions: ["submit"],
  });
  backingRunStore.createRun({
    ...makeRun("run_blocked_rollback", "running"),
    taskId: task.id,
  });
  const failingRunStore = {
    getRun: backingRunStore.getRun.bind(backingRunStore),
    listRuns: backingRunStore.listRuns.bind(backingRunStore),
    reportRun: () => {
      throw new Error("run persistence unavailable");
    },
  };
  const apiKey = createRunnerKey(authStore);
  const server = createServer({
    store: eventStore,
    authStore,
    agentRunStore: failingRunStore,
    taskLifecycleStore: taskQueue,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/agent-runs/run_blocked_rollback/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Need repository credentials.",
      reason: "missing_credentials",
      actionRequired: "Reconnect GitHub.",
      resumeInstructions: "Retry the task after GitHub is connected.",
    }),
  });

  assert.equal(response.status, 500);
  assert.equal(taskQueue.getRawTask(task.id)?.status, "todo");
  assert.equal(taskQueue.getRawTask(task.id)?.blocker, null);
});

test("agent run endpoints enforce authentication and scopes", async (t) => {
  const now = () => new Date("2026-05-09T10:30:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_auth", "running"));
  const usageKey = createUsageKey(authStore);
  const runnerKey = createRunnerKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const unauthenticatedList = await fetch(`${baseUrl}/operator/agent-runs`);
  assert.equal(unauthenticatedList.status, 401);

  const invalidList = await fetch(`${baseUrl}/operator/agent-runs`, {
    headers: {
      authorization: `Bearer ${usageKey.slice(0, -4)}bad`,
    },
  });
  assert.equal(invalidList.status, 401);

  const runnerList = await fetch(`${baseUrl}/operator/agent-runs`, {
    headers: {
      authorization: `Bearer ${runnerKey}`,
    },
  });
  assert.equal(runnerList.status, 403);

  const usageReport = await fetch(`${baseUrl}/agent-runs/run_auth/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${usageKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Should not be accepted.",
    }),
  });
  assert.equal(usageReport.status, 403);
});

test("agent run endpoints return not_found and validation errors", async (t) => {
  const now = () => new Date("2026-05-09T10:40:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const agentRunStore = new AgentRunStore({ now });
  agentRunStore.createRun(makeRun("run_validation", "running"));
  const usageKey = createUsageKey(authStore);
  const runnerKey = createRunnerKey(authStore);
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    agentRunStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const missingGet = await fetch(`${baseUrl}/operator/agent-runs/run_not_found`, {
    headers: {
      authorization: `Bearer ${usageKey}`,
    },
  });
  assert.equal(missingGet.status, 404);
  assert.equal((await missingGet.json()).error.code, "not_found");

  const missingPost = await fetch(`${baseUrl}/agent-runs/run_not_found/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runnerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Missing run.",
    }),
  });
  assert.equal(missingPost.status, 404);
  assert.equal((await missingPost.json()).error.code, "not_found");

  const invalidStatus = await fetch(`${baseUrl}/agent-runs/run_validation/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runnerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "done",
      summary: "Invalid status.",
    }),
  });
  assert.equal(invalidStatus.status, 400);
  assert.equal((await invalidStatus.json()).error.code, "validation_error");

  const missingBlockedMetadata = await fetch(`${baseUrl}/agent-runs/run_validation/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runnerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Missing metadata.",
      reason: "Needs user input.",
      actionRequired: "Provide input.",
    }),
  });
  assert.equal(missingBlockedMetadata.status, 400);
  assert.equal((await missingBlockedMetadata.json()).error.code, "validation_error");

  const invalidHandoff = await fetch(`${baseUrl}/agent-runs/run_validation/report`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runnerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Invalid handoff.",
      handoff: "bad",
    }),
  });
  assert.equal(invalidHandoff.status, 400);
  assert.equal((await invalidHandoff.json()).error.code, "validation_error");
});

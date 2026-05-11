import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentRunStore } from "../src/agent-run-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskEventStore } from "../src/task-event-store.ts";
import type { AwaitingUserNotification } from "../src/desktop-notifier.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
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
  assert.ok(address && typeof address === "object");
  return `http://${address.address}:${address.port}`;
}

async function requestJson(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${path}: ${rawBody.slice(0, 500)}`);
  }
  let body: unknown = null;
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON from ${path} (${response.status}): ${message}; body=${rawBody.slice(0, 500)}`);
    }
  }
  return { response, body };
}

function createAgentKey(authStore: AgentAuthStore, agentId: string): string {
  return authStore.createKey({
    agent: {
      id: agentId,
      displayName: agentId,
      role: "agent",
    },
    scopes: ["tasks:read", "tasks:write"],
  }, `key:${agentId}:desktop-e2e`).data.apiKey;
}

function makeRun(runId: string, taskId: string, taskIdentifier: string) {
  return {
    runId,
    agentId: "agt_run_notify",
    runner: "codex",
    taskId,
    taskIdentifier,
    status: "running" as const,
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    branchName: `agentrail/${taskId}`,
    promptPath: "/tmp/prompt.md",
    logPath: "/tmp/run.log",
    handoffPath: null,
    createdAt: "2026-05-11T12:00:00.000Z",
    startedAt: "2026-05-11T12:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-11T12:00:01.000Z",
    exitCode: null,
    summary: null,
    launch: {
      executable: "codex",
      args: ["exec"],
    },
  };
}

async function waitForNotificationCount(notifications: AwaitingUserNotification[], expectedCount: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (notifications.length !== expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(notifications.length, expectedCount);
}

async function assertNotificationCountRemains(
  notifications: AwaitingUserNotification[],
  expectedCount: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    assert.equal(notifications.length, expectedCount, message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(notifications.length, expectedCount, message);
}

test("awaiting-user desktop notifications are emitted only for blocked work", async (t) => {
  const now = () => new Date("2026-05-11T12:00:00.000Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const agentRunStore = new AgentRunStore({ now });
  const notifications: AwaitingUserNotification[] = [];
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    agentRunStore,
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
  const directApiKey = createAgentKey(authStore, "agt_direct_notify");
  const runApiKey = createAgentKey(authStore, "agt_run_notify");

  const directTask = taskQueue.createTask({
    identifier: "AGEA-DIRECT-BLOCKED",
    title: "Direct blocked task",
    assignee: { id: "agt_direct_notify", name: "Direct Notify" },
    assigneeAgentId: "agt_direct_notify",
    status: "in_progress",
    availableActions: ["submit"],
  });
  const directBlockOptions = {
    method: "POST",
    headers: {
      authorization: `Bearer ${directApiKey}`,
      "idempotency-key": "direct-blocker-notify-e2e",
    },
    body: JSON.stringify({
      sourceRunId: "run_direct_notify",
      sourceAgentId: "agt_direct_notify",
      reason: "Need deployment target.",
      actionRequired: "Choose staging or production.",
      resumeInstructions: "Resume after the target is confirmed.",
    }),
  };

  const directBlock = await requestJson(baseUrl, `/tasks/${directTask.id}/blocker`, directBlockOptions);
  assert.equal(directBlock.response.status, 202);
  await waitForNotificationCount(notifications, 1);
  assert.deepEqual(notifications[0], {
    runId: "run_direct_notify",
    taskId: directTask.id,
    taskIdentifier: "AGEA-DIRECT-BLOCKED",
    reason: "Need deployment target.",
    actionRequired: "Choose staging or production.",
    resumeInstructions: "Resume after the target is confirmed.",
  });

  const directReplay = await requestJson(baseUrl, `/tasks/${directTask.id}/blocker`, directBlockOptions);
  assert.equal(directReplay.response.status, 202);
  await assertNotificationCountRemains(
    notifications,
    1,
    "idempotent blocker replay must not emit duplicate notifications",
  );

  const runTask = taskQueue.createTask({
    identifier: "AGEA-RUN-BLOCKED",
    title: "Run blocked task",
    assignee: { id: "agt_run_notify", name: "Run Notify" },
    assigneeAgentId: "agt_run_notify",
    status: "in_progress",
    availableActions: ["submit"],
  });
  agentRunStore.createRun(makeRun("run_report_notify", runTask.id, runTask.identifier));

  const progressReport = await requestJson(baseUrl, "/agent-runs/run_report_notify/report", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runApiKey}`,
    },
    body: JSON.stringify({
      status: "progress",
      summary: "Still working.",
    }),
  });
  assert.equal(progressReport.response.status, 202);
  await assertNotificationCountRemains(
    notifications,
    1,
    "progress reports must not emit awaiting-user notifications",
  );

  const blockedReport = await requestJson(baseUrl, "/agent-runs/run_report_notify/report", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runApiKey}`,
    },
    body: JSON.stringify({
      status: "blocked",
      summary: "Need GitHub credentials.",
      reason: "Missing GitHub token.",
      actionRequired: "Reconnect GitHub.",
      resumeInstructions: "Retry after GitHub is connected.",
    }),
  });
  assert.equal(blockedReport.response.status, 202);
  await waitForNotificationCount(notifications, 2);
  assert.deepEqual(notifications[1], {
    runId: "run_report_notify",
    taskId: runTask.id,
    taskIdentifier: "AGEA-RUN-BLOCKED",
    reason: "Missing GitHub token.",
    actionRequired: "Reconnect GitHub.",
    resumeInstructions: "Retry after GitHub is connected.",
  });
});

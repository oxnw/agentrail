import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import type http from "node:http";

import { createServer } from "../src/app.ts";
import { AgentTaskQueue, type AgentTaskQueue as AgentTaskQueueType } from "../src/agent-task-queue.ts";
import { LinearCommentWebhookAdapter } from "../src/linear-comment-webhook-adapter.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const NOW = new Date("2026-05-06T12:00:00.000Z");
const TEST_API_BASE_URL = "http://example.invalid";
const WEBHOOK_SECRET = "lin_whsec_endpoint_test";

interface LinearCommentWebhookPayload {
  action: string;
  type: string;
  createdAt: string;
  actor: {
    id: string;
    type: string;
    name: string;
    email: string;
    url: string;
  };
  data: {
    id: string;
    body: string;
    issueId: string;
    userId: string;
  };
  url: string;
  webhookTimestamp: number;
  webhookId: string;
}

type LinearCommentWebhookOverrides = Partial<LinearCommentWebhookPayload> & {
  actor?: Partial<LinearCommentWebhookPayload["actor"]>;
  data?: Partial<LinearCommentWebhookPayload["data"]>;
};

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not expose a TCP address.");
  }
  return `http://${address.address}:${address.port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createRuntime({ webhookSecret = WEBHOOK_SECRET }: { webhookSecret?: string | null } = {}) {
  const eventStore = new TaskEventStore({ now: () => NOW });
  const taskQueue = new AgentTaskQueue({
    now: () => NOW,
    eventStore,
    apiBaseUrl: TEST_API_BASE_URL,
  });
  const linearWebhookAdapter = new LinearCommentWebhookAdapter({
    now: () => NOW,
    eventStore,
    taskQueue,
    apiBaseUrl: TEST_API_BASE_URL,
    webhookSecret,
  });
  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    linearWebhookAdapter,
    now: () => NOW,
  });

  return { eventStore, taskQueue, server };
}

function createLinearTask(taskQueue: AgentTaskQueueType): ReturnType<AgentTaskQueueType["createTask"]> {
  return taskQueue.createTask({
    identifier: "AGEA-134",
    title: "Record Linear comments",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_cto", name: "CTO" },
    links: { issue: "https://linear.app/agentrail/issue/AGEA-134" },
    context: { project: "agentrail", goal: "linear-adapter" },
    availableActions: ["submit"],
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_123",
    },
  });
}

function createCommentPayload(overrides: LinearCommentWebhookOverrides = {}): LinearCommentWebhookPayload {
  const actor = {
    id: "lin_user_1",
    type: "user",
    name: "Maya Reviewer",
    email: "maya@example.com",
    url: "https://linear.app/agentrail/profiles/maya",
    ...overrides.actor,
  };
  const data = {
    id: "lin_comment_1",
    body: "Please preserve the webhook delivery id.",
    issueId: "lin_issue_123",
    userId: "lin_user_1",
    ...overrides.data,
  };
  return {
    action: "create",
    type: "Comment",
    createdAt: "2026-05-06T11:59:30.000Z",
    actor,
    data,
    url: "https://linear.app/agentrail/issue/AGEA-134#comment-lin_comment_1",
    webhookTimestamp: NOW.getTime(),
    webhookId: "lin_webhook_1",
    ...overrides,
  };
}

async function postLinearWebhook(
  baseUrl: string,
  payload: LinearCommentWebhookPayload,
  deliveryId = "lin_delivery_1",
) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return fetch(`${baseUrl}/providers/linear/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": deliveryId,
      "linear-event": "Comment",
      "linear-signature": signature,
    },
    body: rawBody,
  });
}

async function postUnsignedLinearWebhook(
  baseUrl: string,
  payload: LinearCommentWebhookPayload,
  deliveryId = "lin_delivery_1",
) {
  return fetch(`${baseUrl}/providers/linear/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": deliveryId,
      "linear-event": "Comment",
    },
    body: JSON.stringify(payload),
  });
}

test("POST /providers/linear/webhooks records matched comments and returns a recorded receipt", async (t) => {
  const { eventStore, taskQueue, server } = createRuntime();
  const task = createLinearTask(taskQueue);
  t.after(() => closeServer(server));

  const baseUrl = await listen(server);
  const response = await postLinearWebhook(baseUrl, createCommentPayload());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.recorded, true);
  assert.equal(body.data.ignored, false);
  assert.deepEqual(body.data.matchedTasks, [task.id]);
  assert.equal(body.data.eventIds.length, 1);
  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0].type, "task.comment.created");
});

test("POST /providers/linear/webhooks acknowledges unmatched comments without recording events", async (t) => {
  const { eventStore, server } = createRuntime();
  t.after(() => closeServer(server));

  const baseUrl = await listen(server);
  const response = await postLinearWebhook(baseUrl, createCommentPayload());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.recorded, false);
  assert.equal(body.data.ignored, true);
  assert.equal(body.data.ignoredReason, "task_not_found");
  assert.deepEqual(body.data.matchedTasks, []);
  assert.deepEqual(body.data.eventIds, []);
  assert.equal(eventStore.events.length, 0);
});

test("POST /providers/linear/webhooks deduplicates duplicate delivery replay", async (t) => {
  const { eventStore, taskQueue, server } = createRuntime();
  const task = createLinearTask(taskQueue);
  const payload = createCommentPayload();
  t.after(() => closeServer(server));

  const baseUrl = await listen(server);
  const firstResponse = await postLinearWebhook(baseUrl, payload, "lin_delivery_repeat");
  assert.equal(firstResponse.status, 200);
  await firstResponse.body?.cancel();
  const replayResponse = await postLinearWebhook(baseUrl, payload, "lin_delivery_repeat");

  assert.equal(replayResponse.status, 200);
  const replayBody = await replayResponse.json();
  assert.equal(replayBody.data.recorded, false);
  assert.equal(replayBody.data.ignored, true);
  assert.equal(replayBody.data.ignoredReason, "duplicate_delivery");
  assert.deepEqual(replayBody.data.matchedTasks, [task.id]);
  assert.deepEqual(replayBody.data.eventIds, []);
  assert.equal(eventStore.events.length, 1);
});

test("POST /providers/linear/webhooks rejects unsigned requests when a secret is configured", async (t) => {
  const { eventStore, taskQueue, server } = createRuntime();
  createLinearTask(taskQueue);
  t.after(() => closeServer(server));

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/linear/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": "lin_delivery_unsigned",
      "linear-event": "Comment",
    },
    body: JSON.stringify(createCommentPayload()),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "linear_webhook_unauthorized");
  assert.equal(eventStore.events.length, 0);
});

test("POST /providers/linear/webhooks accepts unsigned requests when no secret is configured", async (t) => {
  const { eventStore, taskQueue, server } = createRuntime({ webhookSecret: null });
  createLinearTask(taskQueue);
  t.after(() => closeServer(server));

  const baseUrl = await listen(server);
  const response = await postUnsignedLinearWebhook(baseUrl, createCommentPayload(), "lin_delivery_no_secret");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.recorded, true);
  assert.equal(body.data.ignored, false);
  assert.equal(eventStore.events.length, 1);
});

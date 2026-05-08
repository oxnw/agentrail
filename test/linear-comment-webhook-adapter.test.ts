import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { LinearCommentWebhookAdapter } from "../src/linear-comment-webhook-adapter.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const NOW = new Date("2026-05-06T12:00:00.000Z");

function createAdapter(options: Partial<ConstructorParameters<typeof LinearCommentWebhookAdapter>[0]> = {}) {
  const eventStore = new TaskEventStore({ now: () => NOW });
  const taskQueue = new AgentTaskQueue({
    now: () => NOW,
    eventStore,
    apiBaseUrl: "https://api.agentrail.app/v1",
  });
  const adapter = new LinearCommentWebhookAdapter({
    now: () => NOW,
    eventStore,
    taskQueue,
    apiBaseUrl: "https://api.agentrail.app/v1",
    ...options,
  });

  return { adapter, eventStore, taskQueue };
}

function createLinearTask(
  taskQueue: AgentTaskQueue,
  overrides: Partial<Parameters<AgentTaskQueue["createTask"]>[0]> = {},
) {
  return taskQueue.createTask({
    identifier: "AGEA-134",
    title: "Record Linear comments",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_cto", name: "CTO" },
    links: { issue: "https://linear.app/agentrail/issue/AGEA-134" },
    context: { project: "agentrail", goal: "linear-adapter" },
    availableActions: ["submit", "view_ci_status"],
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_123",
      deliveryId: "linear_issue_delivery_1",
    },
    ...overrides,
  });
}

function createCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Comment",
    createdAt: "2026-05-06T11:59:30.000Z",
    actor: {
      id: "lin_user_1",
      type: "user",
      name: "Maya Reviewer",
      email: "maya@example.com",
      url: "https://linear.app/agentrail/profiles/maya",
    },
    data: {
      id: "lin_comment_1",
      body: "Please preserve the webhook delivery id in the task activity.\n\nThis helps retries stay debuggable.",
      issueId: "lin_issue_123",
      userId: "lin_user_1",
    },
    url: "https://linear.app/agentrail/issue/AGEA-134#comment-lin_comment_1",
    organizationId: "lin_org_1",
    webhookTimestamp: NOW.getTime(),
    webhookId: "lin_webhook_1",
    ...overrides,
  };
}

async function receive(
  adapter: LinearCommentWebhookAdapter,
  payload: Record<string, unknown>,
  deliveryId = "lin_delivery_1",
) {
  const rawBody = JSON.stringify(payload);
  return adapter.receiveWebhook({
    headers: {
      "linear-delivery": deliveryId,
      "linear-event": "Comment",
    },
    rawBody,
  });
}

async function receiveSigned(
  adapter: LinearCommentWebhookAdapter,
  payload: Record<string, unknown>,
  deliveryId = "lin_delivery_1",
  secret = "linear-secret",
) {
  const rawBody = JSON.stringify(payload);
  return adapter.receiveWebhook({
    headers: {
      "linear-delivery": deliveryId,
      "linear-event": "Comment",
      "linear-signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    rawBody,
  });
}

test("LinearCommentWebhookAdapter records matched Comment/create webhooks as compact task events", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter();
  const task = createLinearTask(taskQueue);

  const receipt = await receive(adapter, createCommentPayload());

  assert.equal(receipt.data.recorded, true);
  assert.equal(receipt.data.ignored, false);
  assert.deepEqual(receipt.data.matchedTasks, [task.id]);
  assert.equal(receipt.data.deliveryId, "lin_delivery_1");
  assert.equal(receipt.data.eventIds.length, 1);

  assert.equal(eventStore.events.length, 1);
  const event = eventStore.events[0];
  const linearComment = event.data.linearComment as {
    id: string;
    url: string;
    deliveryId: string;
    bodyPreview: string;
    author: {
      id: string;
      type: string;
      name: string;
      url: string;
    };
  };
  assert.equal(event.type, "task.comment.created");
  assert.equal(event.data.taskId, task.id);
  assert.equal(event.data.taskIdentifier, "AGEA-134");
  assert.equal(event.data.provider, "linear");
  assert.equal(linearComment.id, "lin_comment_1");
  assert.equal(linearComment.url, "https://linear.app/agentrail/issue/AGEA-134#comment-lin_comment_1");
  assert.equal(linearComment.deliveryId, "lin_delivery_1");
  assert.equal(linearComment.bodyPreview, "Please preserve the webhook delivery id in the task activity. This helps retries stay debuggable.");
  assert.deepEqual(linearComment.author, {
    id: "lin_user_1",
    type: "user",
    name: "Maya Reviewer",
    url: "https://linear.app/agentrail/profiles/maya",
  });
});

test("LinearCommentWebhookAdapter acknowledges unmatched comments without appending events", async () => {
  const { adapter, eventStore } = createAdapter();
  const basePayload = createCommentPayload();

  const receipt = await receive(adapter, createCommentPayload({
    data: {
      ...(basePayload.data as Record<string, unknown>),
      issueId: "lin_issue_missing",
    },
  }));

  assert.equal(receipt.data.recorded, false);
  assert.equal(receipt.data.ignored, true);
  assert.equal(receipt.data.ignoredReason, "task_not_found");
  assert.deepEqual(receipt.data.matchedTasks, []);
  assert.deepEqual(receipt.data.eventIds, []);
  assert.equal(eventStore.events.length, 0);
});

test("LinearCommentWebhookAdapter deduplicates duplicate Linear delivery replay", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter();
  const task = createLinearTask(taskQueue);
  const payload = createCommentPayload();

  const firstReceipt = await receive(adapter, payload, "lin_delivery_repeat");
  const replayReceipt = await receive(adapter, payload, "lin_delivery_repeat");

  assert.equal(firstReceipt.data.recorded, true);
  assert.equal(replayReceipt.data.recorded, false);
  assert.equal(replayReceipt.data.ignored, true);
  assert.equal(replayReceipt.data.ignoredReason, "duplicate_delivery");
  assert.deepEqual(replayReceipt.data.matchedTasks, [task.id]);
  assert.deepEqual(replayReceipt.data.eventIds, []);
  assert.equal(eventStore.events.length, 1);
});

test("LinearCommentWebhookAdapter resumes remaining tasks after a partial append failure", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter();
  const firstTask = createLinearTask(taskQueue, { identifier: "AGEA-134-A" });
  const secondTask = createLinearTask(taskQueue, {
    identifier: "AGEA-134-B",
    title: "Record Linear comments on sibling task",
    createdAt: "2026-05-06T12:00:01.000Z",
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_123",
      deliveryId: "linear_issue_delivery_2",
    },
  });
  const payload = createCommentPayload({
    data: {
      id: "lin_comment_partial",
      body: "Record this comment on every linked AgentRail task.",
      issueId: "lin_issue_123",
      userId: "lin_user_1",
    },
  });

  const originalAppend = eventStore.append.bind(eventStore);
  let appendAttempts = 0;
  eventStore.append = (async (event) => {
    appendAttempts += 1;
    if (appendAttempts === 2) {
      throw new Error("simulated append failure");
    }
    return originalAppend(event);
  }) as TaskEventStore["append"];

  await assert.rejects(
    receive(adapter, payload, "lin_delivery_partial"),
    /simulated append failure/,
  );
  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0]?.data.taskId, firstTask.id);

  eventStore.append = originalAppend as TaskEventStore["append"];
  const retryReceipt = await receive(adapter, payload, "lin_delivery_partial");

  assert.equal(retryReceipt.data.recorded, true);
  assert.equal(retryReceipt.data.deduplicated, false);
  assert.deepEqual(retryReceipt.data.matchedTasks, [firstTask.id, secondTask.id]);
  assert.equal(retryReceipt.data.eventIds.length, 2);
  assert.equal(eventStore.events.length, 2);
  assert.deepEqual(
    eventStore.events.map((event) => event.data.taskId),
    [firstTask.id, secondTask.id],
  );
});

test("LinearCommentWebhookAdapter rejects invalid JSON as a validation error", async () => {
  const { adapter } = createAdapter();

  await assert.rejects(
    () => adapter.receiveWebhook({
      headers: {
        "linear-delivery": "lin_delivery_bad_json",
        "linear-event": "Comment",
      },
      rawBody: "{",
    }),
    (error: unknown) => {
      assert.equal((error as { statusCode: number }).statusCode, 400);
      assert.equal((error as { code: string }).code, "validation_error");
      return true;
    },
  );
});

test("LinearCommentWebhookAdapter deduplicates repeated Linear comment ids across deliveries", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter();
  const task = createLinearTask(taskQueue);
  const payload = createCommentPayload();

  await receive(adapter, payload, "lin_delivery_first");
  const duplicateCommentReceipt = await receive(adapter, payload, "lin_delivery_second");

  assert.equal(duplicateCommentReceipt.data.recorded, false);
  assert.equal(duplicateCommentReceipt.data.ignored, true);
  assert.equal(duplicateCommentReceipt.data.ignoredReason, "duplicate_comment");
  assert.deepEqual(duplicateCommentReceipt.data.matchedTasks, [task.id]);
  assert.deepEqual(duplicateCommentReceipt.data.eventIds, []);
  assert.equal(eventStore.events.length, 1);
});

test("LinearCommentWebhookAdapter rejects duplicate delivery ids with different payload fingerprints", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter();
  createLinearTask(taskQueue);
  const payload = createCommentPayload();

  await receive(adapter, payload, "lin_delivery_conflict");

  await assert.rejects(
    () => receive(adapter, createCommentPayload({
      data: {
        ...payload.data,
        body: "Different body with the same Linear delivery id.",
      },
    }), "lin_delivery_conflict"),
    (error: unknown) => {
      const typedError = error as { statusCode: number; code: string; details: { duplicateKey: string; availableActions: string[] } };
      assert.equal(typedError.statusCode, 409);
      assert.equal(typedError.code, "conflict");
      assert.equal(typedError.details.duplicateKey, "delivery");
      assert.deepEqual(typedError.details.availableActions, ["contact_support"]);
      return true;
    }
  );
  assert.equal(eventStore.events.length, 1);
});

test("LinearCommentWebhookAdapter verifies Linear signatures and replay timestamps when a secret is configured", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter({
    webhookSecret: "linear-secret",
    signatureToleranceMs: 60_000,
  });
  const task = createLinearTask(taskQueue);

  const receipt = await receiveSigned(adapter, createCommentPayload(), "lin_delivery_signed");

  assert.equal(receipt.data.recorded, true);
  assert.deepEqual(receipt.data.matchedTasks, [task.id]);
  assert.equal(eventStore.events.length, 1);
});

test("LinearCommentWebhookAdapter rejects missing signatures when a secret is configured", async () => {
  const { adapter, taskQueue } = createAdapter({ webhookSecret: "linear-secret" });
  createLinearTask(taskQueue);

  await assert.rejects(
    () => receive(adapter, createCommentPayload(), "lin_delivery_unsigned"),
    (error: unknown) => {
      assert.equal((error as { statusCode: number }).statusCode, 401);
      assert.equal((error as { code: string }).code, "linear_webhook_unauthorized");
      return true;
    }
  );
});

test("LinearCommentWebhookAdapter rejects missing timestamps when a secret is configured", async () => {
  const { adapter, taskQueue } = createAdapter({ webhookSecret: "linear-secret" });
  createLinearTask(taskQueue);
  const payload = createCommentPayload({ webhookTimestamp: undefined });

  await assert.rejects(
    () => receiveSigned(adapter, payload, "lin_delivery_missing_timestamp"),
    (error: unknown) => {
      const typedError = error as { statusCode: number; code: string; message: string };
      assert.equal(typedError.statusCode, 401);
      assert.equal(typedError.code, "linear_webhook_unauthorized");
      assert.match(typedError.message, /timestamp/);
      return true;
    }
  );
});

test("LinearCommentWebhookAdapter rejects stale signed webhooks outside the replay window", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter({
    webhookSecret: "linear-secret",
    signatureToleranceMs: 60_000,
  });
  createLinearTask(taskQueue);

  await assert.rejects(
    () => receiveSigned(adapter, createCommentPayload({
      webhookTimestamp: NOW.getTime() - 120_000,
    }), "lin_delivery_stale"),
    (error: unknown) => {
      const typedError = error as { statusCode: number; code: string; message: string };
      assert.equal(typedError.statusCode, 401);
      assert.equal(typedError.code, "linear_webhook_unauthorized");
      assert.match(typedError.message, /replay window|timestamp/);
      return true;
    }
  );

  assert.equal(eventStore.events.length, 0);
});

test("LinearCommentWebhookAdapter rejects future signed webhooks outside the replay window", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter({
    webhookSecret: "linear-secret",
    signatureToleranceMs: 60_000,
  });
  createLinearTask(taskQueue);

  await assert.rejects(
    () => receiveSigned(adapter, createCommentPayload({
      webhookTimestamp: NOW.getTime() + 120_000,
    }), "lin_delivery_future"),
    (error: unknown) => {
      const typedError = error as { statusCode: number; code: string; message: string };
      assert.equal(typedError.statusCode, 401);
      assert.equal(typedError.code, "linear_webhook_unauthorized");
      assert.match(typedError.message, /replay window|timestamp/);
      return true;
    }
  );

  assert.equal(eventStore.events.length, 0);
});

test("LinearCommentWebhookAdapter rejects invalid signatures when a secret is configured", async () => {
  const { adapter, taskQueue } = createAdapter({ webhookSecret: "linear-secret" });
  createLinearTask(taskQueue);

  await assert.rejects(
    () => receiveSigned(adapter, createCommentPayload(), "lin_delivery_bad_sig", "wrong-secret"),
    (error: unknown) => {
      assert.equal((error as { statusCode: number }).statusCode, 401);
      assert.equal((error as { code: string }).code, "linear_webhook_unauthorized");
      return true;
    }
  );
});

test("LinearCommentWebhookAdapter rejects odd-length hex signatures", async () => {
  const { adapter, eventStore, taskQueue } = createAdapter({ webhookSecret: "linear-secret" });
  createLinearTask(taskQueue);
  const rawBody = JSON.stringify(createCommentPayload());

  await assert.rejects(
    () => adapter.receiveWebhook({
      headers: {
        "linear-delivery": "lin_delivery_odd_signature",
        "linear-event": "Comment",
        "linear-signature": "abc",
      },
      rawBody,
    }),
    (error: unknown) => {
      assert.equal((error as { statusCode: number }).statusCode, 401);
      assert.equal((error as { code: string }).code, "linear_webhook_unauthorized");
      return true;
    }
  );

  assert.equal(eventStore.events.length, 0);
});

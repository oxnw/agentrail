// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { TaskEventStore } from "../src/task-event-store.js";
import {
  TaskWebhookSubscriptionStore,
  signatureForPayload
} from "../src/task-webhook-store.js";

async function importWorkerModule() {
  try {
    return await import("../src/task-webhook-delivery-worker.js");
  } catch {
    assert.fail("TaskWebhookDeliveryWorker module should exist.");
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function createTaskUpdatedEvent(overrides = {}) {
  return {
    id: "evt_01JY50DG4S5SJC48W0MVV8R3H2",
    type: "task.updated",
    occurredAt: "2026-05-01T03:25:15Z",
    sequence: 4128,
    taskVersion: 9,
    traceId: "trc_01JY50DCRX3AVNQBE6Q71RQB9N",
    data: {
      taskId: "tsk_target",
      taskIdentifier: "AGEA-13",
      status: "in_review",
      previousStatus: "in_progress",
      changedFields: ["status", "availableActions"],
      actor: {
        id: "agt_cto",
        role: "cto"
      },
      summary: "Submission accepted and routed to CEO review.",
      availableActions: ["ship"],
      links: {
        task: "https://api.agentrail.app/v1/tasks/tsk_target",
        reviewFeedback: "https://api.agentrail.app/v1/tasks/tsk_target/review-feedback",
        ciStatus: null,
        shipOperation: null
      }
    },
    ...overrides
  };
}

function createWebhookReceiver(statuses, requests) {
  return http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    requests.push({
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8")
    });

    response.writeHead(statuses.shift() ?? 202, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ accepted: true }));
  });
}

test("TaskWebhookDeliveryWorker retries with contract headers, stable event IDs, fresh delivery IDs, and HMAC signatures", async (t) => {
  const { TaskWebhookDeliveryWorker } = await importWorkerModule();
  let currentTime = new Date("2026-05-01T03:30:00Z");

  const eventStore = new TaskEventStore({ now: () => currentTime });
  const webhookStore = new TaskWebhookSubscriptionStore({ now: () => currentTime });
  const requests = [];
  const receiver = createWebhookReceiver([500, 500, 202], requests);
  const receiverUrl = await listen(receiver);

  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  const subscription = webhookStore.createSubscription(
    {
      url: receiverUrl,
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001",
      filters: {
        taskIds: ["tsk_target"]
      }
    },
    "whsub-worker-retry-v1"
  );

  const event = createTaskUpdatedEvent();
  await eventStore.append(event);

  const worker = new TaskWebhookDeliveryWorker({
    eventStore,
    webhookStore,
    now: () => currentTime
  });

  await worker.processDueDeliveries();
  let delivery = worker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt, 1);
  assert.equal(delivery.nextAttemptAt, "2026-05-01T03:30:10.000Z");

  currentTime = new Date("2026-05-01T03:30:10Z");
  await worker.processDueDeliveries();
  delivery = worker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempt, 2);
  assert.equal(delivery.nextAttemptAt, "2026-05-01T03:30:40.000Z");

  currentTime = new Date("2026-05-01T03:30:40Z");
  await worker.processDueDeliveries();
  delivery = worker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.attempt, 3);
  assert.equal(requests.length, 3);

  const expectedBody = JSON.stringify(event);
  assert.deepEqual(
    requests.map((request) => request.body),
    [expectedBody, expectedBody, expectedBody]
  );
  assert.deepEqual(
    requests.map((request) => request.headers["x-agentrail-event-id"]),
    [event.id, event.id, event.id]
  );
  assert.deepEqual(
    requests.map((request) => request.headers["x-agentrail-delivery-attempt"]),
    ["1", "2", "3"]
  );
  assert.deepEqual(
    requests.map((request) => request.headers["x-agentrail-event-type"]),
    ["task.updated", "task.updated", "task.updated"]
  );
  assert.deepEqual(
    requests.map((request) => request.headers["x-agentrail-webhook-id"]),
    [subscription.data.id, subscription.data.id, subscription.data.id]
  );

  const deliveryIds = requests.map((request) => request.headers["x-agentrail-delivery-id"]);
  assert.equal(new Set(deliveryIds).size, 3);

  for (const request of requests) {
    assert.equal(
      request.headers["x-agentrail-signature"],
      signatureForPayload("whsec_live_agentrail_contract_001", request.body)
    );
  }
});

test("TaskWebhookDeliveryWorker disables the subscription on explicit 410 Gone and stops retrying it", async (t) => {
  const { TaskWebhookDeliveryWorker } = await importWorkerModule();
  let currentTime = new Date("2026-05-01T03:30:00Z");

  const eventStore = new TaskEventStore({ now: () => currentTime });
  const webhookStore = new TaskWebhookSubscriptionStore({ now: () => currentTime });
  const requests = [];
  const receiver = createWebhookReceiver([410, 202], requests);
  const receiverUrl = await listen(receiver);

  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  const subscription = webhookStore.createSubscription(
    {
      url: receiverUrl,
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    },
    "whsub-worker-410-v1"
  );

  const event = createTaskUpdatedEvent();
  await eventStore.append(event);

  const worker = new TaskWebhookDeliveryWorker({
    eventStore,
    webhookStore,
    now: () => currentTime
  });

  await worker.processDueDeliveries();

  const delivery = worker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "disabled");
  assert.deepEqual(webhookStore.listActiveSubscriptions(), []);

  currentTime = new Date("2026-05-01T05:30:00Z");
  await worker.processDueDeliveries();
  assert.equal(requests.length, 1);
});

test("TaskWebhookDeliveryWorker marks the eighth retryable failure as exhausted", async (t) => {
  const { TaskWebhookDeliveryWorker, DELIVERY_SCHEDULE_SECONDS } = await importWorkerModule();
  let currentTime = new Date("2026-05-01T03:30:00Z");

  const eventStore = new TaskEventStore({ now: () => currentTime });
  const webhookStore = new TaskWebhookSubscriptionStore({ now: () => currentTime });
  const requests = [];
  const receiver = createWebhookReceiver([500, 500, 500, 500, 500, 500, 500, 500], requests);
  const receiverUrl = await listen(receiver);

  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  const subscription = webhookStore.createSubscription(
    {
      url: receiverUrl,
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    },
    "whsub-worker-exhausted-v1"
  );

  const event = createTaskUpdatedEvent();
  await eventStore.append(event);

  const worker = new TaskWebhookDeliveryWorker({
    eventStore,
    webhookStore,
    now: () => currentTime
  });

  for (const delaySeconds of DELIVERY_SCHEDULE_SECONDS) {
    currentTime = new Date(currentTime.getTime() + delaySeconds * 1000);
    await worker.processDueDeliveries();
  }

  const delivery = worker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "exhausted");
  assert.equal(delivery.attempt, 8);
  assert.equal(requests.length, 8);
});

test("TaskWebhookDeliveryWorker resumes retry state after a restart when a delivery storage path is configured", async (t) => {
  const { TaskWebhookDeliveryWorker } = await importWorkerModule();
  let currentTime = new Date("2026-05-01T03:30:00Z");

  const deliveryDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-deliveries-"));
  const deliveryStoragePath = path.join(deliveryDir, "deliveries.json");
  const eventStore = new TaskEventStore({ now: () => currentTime });
  const webhookStore = new TaskWebhookSubscriptionStore({ now: () => currentTime });
  const requests = [];
  const receiver = createWebhookReceiver([500, 202], requests);
  const receiverUrl = await listen(receiver);

  t.after(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  const subscription = webhookStore.createSubscription(
    {
      url: receiverUrl,
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    },
    "whsub-worker-persist-v1"
  );

  const event = createTaskUpdatedEvent();
  await eventStore.append(event);

  const firstWorker = new TaskWebhookDeliveryWorker({
    eventStore,
    webhookStore,
    now: () => currentTime,
    storagePath: deliveryStoragePath
  });
  await firstWorker.processDueDeliveries();

  currentTime = new Date("2026-05-01T03:30:10Z");
  const restartedWorker = new TaskWebhookDeliveryWorker({
    eventStore,
    webhookStore,
    now: () => currentTime,
    storagePath: deliveryStoragePath
  });
  await restartedWorker.processDueDeliveries();

  const delivery = restartedWorker.getDelivery(event.id, subscription.data.id);
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.attempt, 2);
  assert.deepEqual(
    requests.map((request) => request.headers["x-agentrail-delivery-attempt"]),
    ["1", "2"]
  );
});

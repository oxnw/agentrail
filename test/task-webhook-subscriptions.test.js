// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { TaskEventStore } from "../src/task-event-store.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test("POST /task-webhook-subscriptions creates a normalized subscription and replays the accepted response for the same idempotency key", async (t) => {
  const now = new Date("2026-05-01T03:20:00Z");
  const server = createServer({
    store: new TaskEventStore(),
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const payload = {
    url: "https://agents.example.com/webhooks/task-events",
    eventTypes: ["task.reviewed", "task.updated", "task.shipped", "task.updated"],
    secret: "whsec_live_agentrail_contract_001",
    description: "Primary automation endpoint for task lifecycle updates.",
    filters: {
      taskIds: ["tsk_b", "tsk_a", "tsk_a"]
    }
  };

  const response = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-16-v1"
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 201);

  const firstBody = await response.json();
  assert.match(firstBody.data.id, /^whsub_/);
  assert.equal(firstBody.data.status, "active");
  assert.deepEqual(firstBody.data.eventTypes, [
    "task.reviewed",
    "task.shipped",
    "task.updated"
  ]);
  assert.deepEqual(firstBody.data.filters.taskIds, ["tsk_a", "tsk_b"]);
  assert.equal(firstBody.data.signingAlgorithm, "hmac_sha256");
  assert.deepEqual(firstBody.data.retryPolicy, {
    maxAttempts: 8,
    initialBackoffSeconds: 10,
    maxBackoffSeconds: 3600
  });
  assert.deepEqual(firstBody.data.availableActions, ["deactivate"]);
  assert.deepEqual(firstBody.availableActions, ["deactivate"]);

  const replayResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-16-v1"
    },
    body: JSON.stringify(payload)
  });

  assert.equal(replayResponse.status, 201);
  const replayBody = await replayResponse.json();
  assert.deepEqual(replayBody, firstBody);

  const duplicateResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-16-v2"
    },
    body: JSON.stringify({
      ...payload,
      eventTypes: ["task.updated", "task.shipped", "task.reviewed"],
      filters: {
        taskIds: ["tsk_a", "tsk_b"]
      }
    })
  });

  assert.equal(duplicateResponse.status, 409);
  const duplicateBody = await duplicateResponse.json();
  assert.equal(duplicateBody.error.code, "conflict");
  assert.equal(
    duplicateBody.error.message,
    "An active subscription already exists for this endpoint and filter set."
  );
  assert.equal(duplicateBody.error.details.subscriptionId, firstBody.data.id);
});

test("DELETE /task-webhook-subscriptions/{subscriptionId} disables the subscription and clears available actions", async (t) => {
  const now = new Date("2026-05-01T03:20:00Z");
  const server = createServer({
    store: new TaskEventStore(),
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  const createResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-16-delete-v1"
    },
    body: JSON.stringify({
      url: "https://agents.example.com/webhooks/task-events",
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    })
  });

  assert.equal(createResponse.status, 201);
  const createdBody = await createResponse.json();

  const deleteResponse = await fetch(
    `${baseUrl}/task-webhook-subscriptions/${createdBody.data.id}`,
    {
      method: "DELETE"
    }
  );

  assert.equal(deleteResponse.status, 202);

  const deletedBody = await deleteResponse.json();
  assert.equal(deletedBody.data.id, createdBody.data.id);
  assert.equal(deletedBody.data.status, "disabled");
  assert.deepEqual(deletedBody.data.availableActions, []);
  assert.deepEqual(deletedBody.availableActions, []);
});

test("GET /task-webhook-subscriptions lists subscriptions and GET /task-webhook-subscriptions/{subscriptionId} returns a snapshot", async (t) => {
  const now = new Date("2026-05-01T03:25:00Z");
  const server = createServer({
    store: new TaskEventStore(),
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const createPrimary = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-17-list-v1"
    },
    body: JSON.stringify({
      url: "https://agents.example.com/webhooks/primary",
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001",
      filters: {
        taskIds: ["tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V"]
      }
    })
  });
  const createSecondary = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "whsub-AGEA-17-list-v2"
    },
    body: JSON.stringify({
      url: "https://agents.example.com/webhooks/secondary",
      eventTypes: ["task.reviewed"],
      secret: "whsec_live_agentrail_contract_002"
    })
  });

  assert.equal(createPrimary.status, 201);
  assert.equal(createSecondary.status, 201);
  const primaryBody = await createPrimary.json();
  const secondaryBody = await createSecondary.json();

  const deleteResponse = await fetch(
    `${baseUrl}/task-webhook-subscriptions/${secondaryBody.data.id}`,
    {
      method: "DELETE"
    }
  );
  assert.equal(deleteResponse.status, 202);

  const listResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`);

  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.deepEqual(
    listBody.data.map((subscription) => subscription.id),
    [primaryBody.data.id, secondaryBody.data.id]
  );
  assert.equal(listBody.data[0].status, "active");
  assert.equal(listBody.data[1].status, "disabled");
  assert.deepEqual(listBody.availableActions, ["create"]);

  const getResponse = await fetch(
    `${baseUrl}/task-webhook-subscriptions/${secondaryBody.data.id}`
  );

  assert.equal(getResponse.status, 200);
  const getBody = await getResponse.json();
  assert.equal(getBody.data.id, secondaryBody.data.id);
  assert.equal(getBody.data.status, "disabled");
  assert.deepEqual(getBody.data.availableActions, []);
  assert.deepEqual(getBody.availableActions, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type http from "node:http";

import { createServer } from "../src/app.ts";
import { createAgentShipCycleDemoStore, DEMO_TASK_ID } from "./helpers/deterministic-lifecycle-store.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://${address.address}:${address.port}`;
}

test("GET /health returns an operational health payload", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    now: () => new Date("2026-05-04T14:54:17.000Z")
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.status, "ok");
  assert.equal(body.service, "agentrail-service");
  assert.equal(body.publicBaseUrl, baseUrl);
  assert.equal(body.pathPrefix, null);
  assert.equal(body.time, "2026-05-04T14:54:17.000Z");
  assert.equal(Number.isInteger(body.uptimeSeconds), true);
});

test("GET /v1/health works when the public API base URL is versioned", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    now: () => new Date("2026-05-04T14:55:00.000Z"),
    publicBaseUrl: "https://api.agentrail.app/v1"
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/v1/health`);

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.publicBaseUrl, "https://api.agentrail.app/v1");
  assert.equal(body.pathPrefix, "/v1");
  assert.equal(body.time, "2026-05-04T14:55:00.000Z");
});

test("GET /v1/tasks/mine reuses the version prefix for public deployments", async (t) => {
  const eventStore = new TaskEventStore();
  const taskLifecycleStore = createAgentShipCycleDemoStore({
    eventStore,
    apiBaseUrl: "https://api.agentrail.app/v1"
  });
  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    reviewFeedbackAdapter: taskLifecycleStore,
    publicBaseUrl: "https://api.agentrail.app/v1"
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/v1/tasks/mine?status=in_progress`);

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, DEMO_TASK_ID);
});

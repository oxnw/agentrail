import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { TaskEventStore } from "../src/task-event-store.js";

function createTaskUpdatedEvent(overrides = {}) {
  const event = {
    id: "evt_01JY50DG4S5SJC48W0MVV8R3H2",
    type: "task.updated",
    occurredAt: "2026-05-01T03:25:15Z",
    sequence: 4128,
    taskVersion: 9,
    traceId: "trc_01JY50DCRX3AVNQBE6Q71RQB9N",
    data: {
      taskId: "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
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
        task: "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
        reviewFeedback:
          "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback",
        ciStatus: null,
        shipOperation: null
      }
    }
  };

  return {
    ...event,
    ...overrides,
    data: {
      ...event.data,
      ...overrides.data,
      actor: {
        ...event.data.actor,
        ...overrides.data?.actor
      },
      links: {
        ...event.data.links,
        ...overrides.data?.links
      }
    }
  };
}

function createTaskReviewedEvent(overrides = {}) {
  const event = {
    id: "evt_01JY50DG4S5SJC48W0MVV8R3H9",
    type: "task.reviewed",
    occurredAt: "2026-05-01T03:26:15Z",
    sequence: 4130,
    taskVersion: 11,
    traceId: "trc_01JY50DCRX3AVNQBE6Q71RQB9Q",
    data: {
      taskId: "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
      taskIdentifier: "AGEA-13",
      status: "in_review",
      reviewOutcome: "approved",
      reviewer: {
        id: "agt_ceo",
        role: "ceo"
      },
      summary: "Contract approved for ship.",
      availableActions: ["ship"],
      links: {
        task: "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
        reviewFeedback:
          "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback",
        ciStatus: null,
        shipOperation: null
      }
    }
  };

  return {
    ...event,
    ...overrides,
    data: {
      ...event.data,
      ...overrides.data,
      reviewer: {
        ...event.data.reviewer,
        ...overrides.data?.reviewer
      },
      links: {
        ...event.data.links,
        ...overrides.data?.links
      }
    }
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function readUntil(response, matcher, timeoutMs = 12_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";

  while (Date.now() < deadline) {
    const timeout = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for SSE data")), timeout);
      })
    ]);

    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });
    if (matcher(buffer)) {
      reader.releaseLock();
      return buffer;
    }
  }

  throw new Error("Expected SSE output was not observed before timeout");
}

function parseEventPayloads(sseOutput) {
  return sseOutput
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

test("GET /task-events/stream starts on the live tail and emits keepalives", async (t) => {
  const store = new TaskEventStore();
  const server = createServer({ store });
  const abortController = new AbortController();

  t.after(async () => {
    abortController.abort();
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/task-events/stream?heartbeatSeconds=10`, {
    signal: abortController.signal
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-agentrail-replay-window-hours"), "72");
  assert.equal(response.headers.get("x-agentrail-resume-mode"), "live");
  assert.equal(response.headers.get("x-agentrail-stream-heartbeat-seconds"), "10");

  await store.append(
    createTaskUpdatedEvent({
      occurredAt: "2026-05-01T03:25:16Z",
      sequence: 4129,
      taskVersion: 10
    })
  );

  const sseOutput = await readUntil(
    response,
    (buffer) =>
      buffer.includes("event: task.updated") &&
      buffer.includes(": keepalive")
  );

  assert.match(sseOutput, /retry: 5000/);
  assert.match(sseOutput, /id: evt_01JY50DG4S5SJC48W0MVV8R3H2/);
  assert.match(sseOutput, /event: task.updated/);

  const dataLine = sseOutput
    .split("\n")
    .find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));

  assert.equal(payload.sequence, 4129);
  assert.equal(payload.taskVersion, 10);
  assert.equal(payload.data.taskId, "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");

  await response.body.cancel();
});

test("GET /task-events/stream resumes from Last-Event-ID before switching back to live delivery", async (t) => {
  const FIXTURE_NOW = new Date("2026-05-01T03:25:15Z");
  const store = new TaskEventStore({ now: () => FIXTURE_NOW });
  const server = createServer({ store, now: () => FIXTURE_NOW });
  const abortController = new AbortController();

  t.after(async () => {
    abortController.abort();
    await new Promise((resolve) => server.close(resolve));
  });

  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3H0",
      sequence: 4127,
      taskVersion: 8
    })
  );
  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3H1",
      sequence: 4128,
      taskVersion: 9
    })
  );
  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3H2",
      sequence: 4129,
      taskVersion: 10
    })
  );

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/task-events/stream?cursor=evt_01JY50DG4S5SJC48W0MVV8R3H0`,
    {
      headers: {
        "Last-Event-ID": "evt_01JY50DG4S5SJC48W0MVV8R3H1"
      },
      signal: abortController.signal
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-agentrail-resume-mode"), "replay_then_live");

  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3H3",
      occurredAt: "2026-05-01T03:25:16Z",
      sequence: 4130,
      taskVersion: 11
    })
  );

  const sseOutput = await readUntil(
    response,
    (buffer) =>
      buffer.includes("evt_01JY50DG4S5SJC48W0MVV8R3H2") &&
      buffer.includes("evt_01JY50DG4S5SJC48W0MVV8R3H3")
  );

  assert.ok(!sseOutput.includes("evt_01JY50DG4S5SJC48W0MVV8R3H1"));

  const payloads = parseEventPayloads(sseOutput);
  assert.deepEqual(
    payloads.map((payload) => payload.sequence),
    [4129, 4130]
  );
  assert.deepEqual(
    payloads.map((payload) => payload.taskVersion),
    [10, 11]
  );

  await response.body.cancel();
});

test("GET /task-events/stream returns 410 for an expired cursor", async (t) => {
  const fixedNow = new Date("2026-05-04T12:00:00Z");
  const store = new TaskEventStore({ now: () => fixedNow });
  const server = createServer({ store, now: () => fixedNow });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3HX",
      occurredAt: "2026-04-30T11:59:59Z",
      sequence: 4001,
      taskVersion: 1
    })
  );

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/task-events/stream?cursor=evt_01JY50DG4S5SJC48W0MVV8R3HX`);

  assert.equal(response.status, 410);
  assert.equal(response.headers.get("content-type"), "application/json");

  const body = await response.json();
  assert.equal(body.error.code, "cursor_expired");
  assert.equal(body.error.details.replayWindowHours, 72);
  assert.deepEqual(body.error.details.availableActions, ["reconnect_without_cursor"]);
});

test("GET /task-events/stream respects taskId and eventTypes filters with interleaved traffic", async (t) => {
  const store = new TaskEventStore();
  const server = createServer({ store });
  const abortController = new AbortController();

  t.after(async () => {
    abortController.abort();
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/task-events/stream?taskId=tsk_target&eventTypes=task.updated`,
    {
      signal: abortController.signal
    }
  );

  assert.equal(response.status, 200);

  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3HA",
      sequence: 5001,
      taskVersion: 1,
      data: {
        taskId: "tsk_other",
        taskIdentifier: "AGEA-99"
      }
    })
  );
  await store.append(
    createTaskReviewedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3HB",
      sequence: 5002,
      data: {
        taskId: "tsk_target",
        taskIdentifier: "AGEA-15"
      }
    })
  );
  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3HC",
      sequence: 5003,
      taskVersion: 2,
      data: {
        taskId: "tsk_target",
        taskIdentifier: "AGEA-15"
      }
    })
  );
  await store.append(
    createTaskUpdatedEvent({
      id: "evt_01JY50DG4S5SJC48W0MVV8R3HD",
      sequence: 5004,
      taskVersion: 3,
      data: {
        taskId: "tsk_target",
        taskIdentifier: "AGEA-15"
      }
    })
  );

  const sseOutput = await readUntil(
    response,
    (buffer) =>
      buffer.includes("evt_01JY50DG4S5SJC48W0MVV8R3HC") &&
      buffer.includes("evt_01JY50DG4S5SJC48W0MVV8R3HD")
  );

  assert.ok(!sseOutput.includes("evt_01JY50DG4S5SJC48W0MVV8R3HA"));
  assert.ok(!sseOutput.includes("evt_01JY50DG4S5SJC48W0MVV8R3HB"));

  const payloads = parseEventPayloads(sseOutput);
  assert.deepEqual(
    payloads.map((payload) => payload.data.taskId),
    ["tsk_target", "tsk_target"]
  );
  assert.deepEqual(
    payloads.map((payload) => payload.sequence),
    [5003, 5004]
  );

  await response.body.cancel();
});

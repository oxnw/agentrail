// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/app.js";
import { TaskEventStore } from "../src/task-event-store.js";

test("POST /tasks/{id}/ship rejects before task exposes ship action", async () => {
  const now = () => new Date("2026-05-04T00:00:00Z");
  const eventStore = new TaskEventStore({ now });
  let shipCalls = 0;
  const taskLifecycleStore = {
    async getTask(taskId) {
      return {
        data: {
          id: taskId,
          status: "in_progress",
          availableActions: ["submit", "view_ci_status"],
        },
        availableActions: ["submit", "view_ci_status"],
      };
    },
    async shipTask() {
      shipCalls += 1;
      return {
        data: {
          taskId: "tsk_gate",
          operationId: "shp_should_not_run",
          status: "succeeded",
          queuedAt: now().toISOString(),
          availableActions: [],
        },
        availableActions: [],
      };
    },
  };

  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    now,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/tsk_gate/ship`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "ship-gate-001",
      },
      body: JSON.stringify({
        mode: "merge_only",
        targetEnvironment: "production",
        expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
      }),
    });

    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error.code, "conflict");
    assert.deepEqual(json.error.details.availableActions, ["submit", "view_ci_status"]);
    assert.equal(shipCalls, 0, "ship provider must not run before task exposes ship");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

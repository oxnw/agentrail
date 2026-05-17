import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.ts";
import { createAgentShipCycleDemoStore } from "./helpers/deterministic-lifecycle-store.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  return { response, body };
}

test("agent can complete a deterministic lifecycle flow through AgentRail endpoints", async (t) => {
  const now = () => new Date("2026-05-01T10:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskLifecycleStore = createAgentShipCycleDemoStore({
    now,
    eventStore
  });
  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    ciStatusAdapter: taskLifecycleStore,
    reviewFeedbackAdapter: taskLifecycleStore,
    now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);

  const mine = await requestJson(baseUrl, "/tasks/mine?status=in_progress&limit=1");
  assert.equal(mine.response.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].id, "tsk_DEMOISSUETOSHIP01");
  assert.deepEqual(mine.body.data[0].availableActions, ["submit"]);

  const firstSubmit = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/submit", {
    method: "POST",
    headers: { "idempotency-key": "submit-demo-1" },
    body: JSON.stringify({
      summary: "Implemented the failing endpoint and opened a pull request.",
      artifacts: [
        {
          type: "pull_request",
          url: "https://github.com/oxnw/agentrail/pull/42"
        }
      ],
      checks: [{ name: "unit-tests", status: "failed" }],
      notes: "First pass intentionally demonstrates the feedback loop."
    })
  });
  assert.equal(firstSubmit.response.status, 202);
  assert.equal(firstSubmit.body.data.status, "in_review");

  const failedCi = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/ci-status");
  assert.equal(failedCi.response.status, 200);
  assert.equal(failedCi.body.data.overallStatus, "failed");
  assert.equal(failedCi.body.data.failureSummaries[0].file, "src/app.js");

  const requestedChanges = await requestJson(
    baseUrl,
    "/tasks/tsk_DEMOISSUETOSHIP01/review-feedback"
  );
  assert.equal(requestedChanges.response.status, 200);
  assert.equal(requestedChanges.body.data.latestDecision.outcome, "changes_requested");
  assert.deepEqual(requestedChanges.body.availableActions, ["fix"]);

  const secondSubmit = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/submit", {
    method: "POST",
    headers: { "idempotency-key": "submit-demo-2" },
    body: JSON.stringify({
      summary: "Fixed idempotency handling and added a regression test.",
      artifacts: [
        {
          type: "pull_request",
          url: "https://github.com/oxnw/agentrail/pull/42"
        },
        {
          type: "commit",
          url: "https://github.com/oxnw/agentrail/commit/b5bc7f86"
        }
      ],
      checks: [{ name: "unit-tests", status: "passed" }],
      notes: null
    })
  });
  assert.equal(secondSubmit.response.status, 202);

  const greenCi = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/ci-status");
  assert.equal(greenCi.response.status, 200);
  assert.equal(greenCi.body.data.overallStatus, "passed");
  assert.deepEqual(greenCi.body.availableActions, ["view_review_feedback"]);

  const approvedReview = await requestJson(
    baseUrl,
    "/tasks/tsk_DEMOISSUETOSHIP01/review-feedback"
  );
  assert.equal(approvedReview.response.status, 200);
  assert.equal(approvedReview.body.data.latestDecision.outcome, "approved");
  assert.deepEqual(approvedReview.body.data.availableActions, ["ship"]);

  const ship = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01/ship", {
    method: "POST",
    headers: { "idempotency-key": "ship-demo-1" },
    body: JSON.stringify({
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
    })
  });
  assert.equal(ship.response.status, 202);
  assert.equal(ship.body.data.status, "queued");

  const shippedTask = await requestJson(baseUrl, "/tasks/tsk_DEMOISSUETOSHIP01");
  assert.equal(shippedTask.response.status, 200);
  assert.equal(shippedTask.body.data.status, "done");
  assert.deepEqual(shippedTask.body.data.availableActions, ["rollback"]);

  assert.equal(eventStore.getMaxSequence(), 3);
});

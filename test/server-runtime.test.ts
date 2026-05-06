import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntime, parseTaskSources } from "../src/server-runtime.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const now = () => new Date("2026-05-06T15:00:00.000Z");

test("parseTaskSources returns null when live provider sources are not configured", () => {
  assert.equal(parseTaskSources(null), null);
});

test("buildRuntime starts without live provider configuration", () => {
  const runtime = buildRuntime({
    taskSourcesJson: null,
    githubToken: null,
    circleciToken: null,
    now,
    eventStore: new TaskEventStore({ now }),
    publicBaseUrl: "http://127.0.0.1:3000",
  });

  assert.ok(runtime.taskLifecycleStore);
  assert.ok(runtime.routingControlPlane);
  assert.equal(runtime.ciStatusAdapter, null);
  assert.equal(runtime.reviewFeedbackAdapter, null);
  assert.equal(runtime.rollbackAdapter, null);
  assert.ok(runtime.intakeAdapter);
});

test("parseTaskSources still rejects malformed live provider configuration", () => {
  assert.throws(
    () => parseTaskSources("{"),
    /AGENTRAIL_TASK_SOURCES must be a JSON object keyed by task id/,
  );
});

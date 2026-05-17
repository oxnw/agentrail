import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.ts";
import { ReviewFeedbackSourceError } from "../src/github-review-feedback-adapter.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test("GET /tasks/{id}/review-feedback returns unified feedback sorted by severity", async (t) => {
  const reviewFeedbackAdapter = {
    async getTaskReviewFeedback(taskId) {
      assert.equal(taskId, "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");

      return {
        data: {
          taskId,
          latestDecision: {
            outcome: "changes_requested",
            reviewer: { id: "octocat", role: "owner" },
            createdAt: "2026-05-01T03:05:40Z",
            summary: "Add explicit idempotency semantics to ship endpoint."
          },
          comments: [
            {
              id: "rc_101",
              authorRole: "owner",
              body: "This must be fixed before merge.",
              severity: "must_fix",
              file: "src/app.js",
              line: 42,
              suggestedAction: null
            },
            {
              id: "rc_102",
              authorRole: "contributor",
              body: "Consider using a constant here.",
              severity: "should_fix",
              file: "src/config.js",
              line: 10,
              suggestedAction: 'const TIMEOUT = 5000;'
            },
            {
              id: "ic_201",
              authorRole: "member",
              body: "Nice approach overall.",
              severity: "note",
              file: null,
              line: null,
              suggestedAction: null
            }
          ],
          availableActions: ["fix"]
        },
        availableActions: ["fix"]
      };
    }
  };

  const server = createServer({
    store: new TaskEventStore(),
    reviewFeedbackAdapter
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback`
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.data.taskId, "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");
  assert.equal(body.data.latestDecision.outcome, "changes_requested");
  assert.equal(body.data.latestDecision.reviewer.id, "octocat");
  assert.equal(body.data.comments.length, 3);
  assert.equal(body.data.comments[0].severity, "must_fix");
  assert.equal(body.data.comments[0].file, "src/app.js");
  assert.equal(body.data.comments[0].line, 42);
  assert.equal(body.data.comments[1].severity, "should_fix");
  assert.equal(body.data.comments[1].suggestedAction, 'const TIMEOUT = 5000;');
  assert.equal(body.data.comments[2].severity, "note");
  assert.deepEqual(body.availableActions, ["fix"]);
});

test("GET /tasks/{id}/review-feedback returns 404 when adapter has no source", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    reviewFeedbackAdapter: {
      async getTaskReviewFeedback() {
        return null;
      }
    }
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback`
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
  assert.deepEqual(body.error.details.availableActions, ["list_my_tasks"]);
});

test("GET /tasks/{id}/review-feedback returns structured source errors", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    reviewFeedbackAdapter: {
      async getTaskReviewFeedback() {
        throw new ReviewFeedbackSourceError("GitHub review source rejected the request.", {
          statusCode: 429,
          code: "review_source_rate_limited",
          details: {
            sourceStatus: 403,
            availableActions: ["retry"]
          }
        });
      }
    }
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback`
  );

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "review_source_rate_limited");
});

test("GET /tasks/{id}/review-feedback returns 404 when no adapter is configured", async (t) => {
  const server = createServer({
    store: new TaskEventStore()
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback`
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";

import { createServer } from "../src/app.js";
import { CircleCiStatusAdapter } from "../src/circleci-status-adapter.js";
import { CiStatusSourceError } from "../src/github-actions-ci-adapter.js";
import { TaskEventStore } from "../src/task-event-store.js";
import {
  circleCiTaskId,
  circleCiTaskSource,
  failedUnitTestsResponse,
  jobCompletedWebhook
} from "./fixtures/circleci-fixtures.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test("GET /tasks/{id}/ci-status returns structured CI failures without raw logs", async (t) => {
  const ciStatusAdapter = {
    async getTaskCiStatus(taskId) {
      assert.equal(taskId, "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");

      return {
        data: {
          taskId,
          submissionId: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
          overallStatus: "failed",
          summary: {
            total: 3,
            passed: 1,
            failed: 1,
            running: 1,
            queued: 0,
            cancelled: 0,
            skipped: 0
          },
          workflows: [
            {
              name: "CI",
              path: ".github/workflows/ci.yml",
              status: "failed",
              passed: 1,
              failed: 1,
              running: 1,
              url: "https://github.com/oxnw/agentrail/actions/runs/1201"
            }
          ],
          checks: [
            {
              name: "unit-tests",
              workflow: "CI",
              status: "failed",
              url: "https://github.com/oxnw/agentrail/actions/runs/1201/job/11",
              durationSeconds: 42,
              failureCount: 1
            },
            {
              name: "contract-tests",
              workflow: "CI",
              status: "running",
              url: "https://github.com/oxnw/agentrail/actions/runs/1201/job/12",
              durationSeconds: null,
              failureCount: 0
            }
          ],
          failureSummaries: [
            {
              checkName: "unit-tests",
              workflow: "CI",
              testName: "GET /tasks/{id}/ci-status returns structured failures",
              file: "test/ci-status-endpoint.test.js",
              line: 44,
              message: "Expected status 200 but received 500"
            }
          ],
          flakyHints: [
            {
              checkName: "unit-tests",
              confidence: "medium",
              reason: "same check passed on a previous run for this head SHA"
            }
          ],
          updatedAt: "2026-05-01T03:03:19Z",
          availableActions: ["retry_failed_checks", "view_logs"]
        },
        availableActions: ["retry_failed_checks", "view_logs"],
        meta: {
          tokenBudgetHint: "standard",
          truncatedFields: []
        }
      };
    }
  };
  const server = createServer({
    store: new TaskEventStore(),
    ciStatusAdapter
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.data.overallStatus, "failed");
  assert.deepEqual(body.data.summary, {
    total: 3,
    passed: 1,
    failed: 1,
    running: 1,
    queued: 0,
    cancelled: 0,
    skipped: 0
  });
  assert.equal(body.data.workflows[0].path, ".github/workflows/ci.yml");
  assert.equal(body.data.failureSummaries[0].file, "test/ci-status-endpoint.test.js");
  assert.equal(body.data.failureSummaries[0].line, 44);
  assert.equal(body.data.failureSummaries[0].message, "Expected status 200 but received 500");
  assert.deepEqual(body.data.flakyHints, [
    {
      checkName: "unit-tests",
      confidence: "medium",
      reason: "same check passed on a previous run for this head SHA"
    }
  ]);
  assert.equal(JSON.stringify(body).includes("raw log line"), false);
  assert.deepEqual(body.availableActions, ["retry_failed_checks", "view_logs"]);
  assert.equal(body.meta.tokenBudgetHint, "standard");
});

test("GET /tasks/{id}/ci-status returns not_found when the adapter has no CI source for a task", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    ciStatusAdapter: {
      async getTaskCiStatus() {
        return null;
      }
    }
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
  assert.deepEqual(body.error.details.availableActions, ["list_my_tasks"]);
});

test("GET /tasks/{id}/ci-status returns structured source errors from GitHub Actions", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    ciStatusAdapter: {
      async getTaskCiStatus() {
        throw new CiStatusSourceError("GitHub Actions CI source rejected the request.", {
          statusCode: 429,
          code: "ci_source_rate_limited",
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
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`
  );

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "ci_source_rate_limited");
  assert.equal(body.error.message, "GitHub Actions CI source rejected the request.");
  assert.deepEqual(body.error.details, {
    sourceStatus: 403,
    availableActions: ["retry"]
  });
});

test("POST /providers/circleci/webhooks accepts a signed CircleCI event and primes CI status lookups", async (t) => {
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    webhookSecret: "super-secret",
    taskSources: {
      [circleCiTaskId]: circleCiTaskSource
    },
    fetch: async (url) => {
      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse({
          items: failedUnitTestsResponse.items
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const server = createServer({
    store: new TaskEventStore(),
    ciStatusAdapter: adapter
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const rawBody = JSON.stringify(jobCompletedWebhook);
  const webhookResponse = await fetch(`${baseUrl}/providers/circleci/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "circleci-signature": `v1=${createHmac("sha256", "super-secret").update(rawBody).digest("hex")}`
    },
    body: rawBody
  });

  assert.equal(webhookResponse.status, 202);
  const webhookBody = await webhookResponse.json();
  assert.deepEqual(webhookBody.data.matchedTasks, [circleCiTaskId]);

  const statusResponse = await fetch(`${baseUrl}/tasks/${circleCiTaskId}/ci-status`);
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.data.overallStatus, "failed");
  assert.equal(statusBody.data.failureSummaries[0].message, "Expected status 200 but received 500");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

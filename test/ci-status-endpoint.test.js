// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";

import { createServer } from "../src/app.ts";
import { CircleCiStatusAdapter } from "../src/circleci-status-adapter.ts";
import { CiStatusSourceError } from "../src/github-actions-ci-adapter.ts";
import { TaskEventStore } from "../src/task-event-store.ts";
import {
  circleCiTaskId,
  circleCiTaskSource,
  failedUnitTestsResponse,
  jobCompletedWebhook
} from "./fixtures/circleci-fixtures.js";

const githubTaskId = "tsk_github_01";

function makeTask(source) {
  return {
    id: circleCiTaskId,
    identifier: "AGEA-101",
    title: "Persist CircleCI metadata",
    description: "",
    status: "in_review",
    priority: "high",
    assignee: { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: [],
    links: { issue: "https://example.com/issues/101" },
    context: { project: "oxnw/agentrail", goal: "test" },
    updatedAt: "2026-05-05T12:00:00Z",
    availableActions: ["view_ci_status"],
    submissions: [],
    latestSubmissionId: null,
    ciStatus: null,
    reviewOutcome: null,
    shipOperation: null,
    rollbackOperation: null,
    dueAt: null,
    createdAt: "2026-05-05T12:00:00Z",
    version: 1,
    source,
  };
}

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
    getTask: () => makeTask(circleCiTaskSource),
    listTasks: () => [makeTask(circleCiTaskSource)],
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

test("POST /providers/github/webhooks returns 401 for an invalid signature", async (t) => {
  const server = createServer({
    store: new TaskEventStore(),
    githubWebhookSecret: "github-secret",
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": "sha256=bad",
    },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "github_webhook_unauthorized");
});

test("POST /providers/github/webhooks returns 400 for malformed JSON", async (t) => {
  const rawBody = "{not json";
  const server = createServer({
    store: new TaskEventStore(),
    githubWebhookSecret: "github-secret",
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`,
    },
    body: rawBody,
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "validation_error");
});

test("POST /providers/github/webhooks only matches workflow_run tasks with explicit branch or head sha correlation", async (t) => {
  const eventStore = new TaskEventStore();
  const projectedTaskIds = [];
  const projectedProviders = [];
  const projectedHeadShas = [];
  const tasks = [
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 21,
        branch: "feature/keep-me",
      }),
      id: githubTaskId,
      identifier: "github:oxnw/agentrail:issues/21",
    },
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 23,
      }),
      id: "tsk_sha_match",
      identifier: "github:oxnw/agentrail:issues/23",
      source: {
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 23,
        headSha: "sha-abc123",
      },
    },
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 22,
      }),
      id: "tsk_unrelated",
      identifier: "github:oxnw/agentrail:issues/22",
      source: {
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 22,
      },
    },
  ];
  const server = createServer({
    store: eventStore,
    githubWebhookSecret: "github-secret",
    taskLifecycleStore: {
      listRawTasks: () => tasks,
      getRawTask: (taskId) => tasks.find((task) => task.id === taskId) ?? null,
      async projectCiState(taskId, observation) {
        projectedTaskIds.push(taskId);
        projectedProviders.push(observation.provider);
        projectedHeadShas.push(observation.headSha);
      },
    },
    ciStatusAdapter: {
      async getTaskCiStatus() {
        return {
          data: {
            overallStatus: "passed",
            summary: { total: 1, passed: 1, failed: 0, running: 0, queued: 0, cancelled: 0, skipped: 0 },
            failureSummaries: [],
            updatedAt: "2026-05-08T00:00:00Z",
          },
        };
      },
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const payload = {
    repository: { owner: { login: "oxnw" }, name: "agentrail" },
    workflow_run: {
      head_branch: "feature/keep-me",
      head_sha: "sha-abc123",
    },
  };
  const rawBody = JSON.stringify(payload);
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`,
    },
    body: rawBody,
  });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(body.data.matchedTasks, [githubTaskId, "tsk_sha_match"]);
  assert.deepEqual(projectedTaskIds, [githubTaskId, "tsk_sha_match"]);
  assert.deepEqual(projectedProviders, ["github_actions", "github_actions"]);
  assert.deepEqual(projectedHeadShas, ["sha-abc123", "sha-abc123"]);
});

test("POST /providers/github/webhooks preserves explicit null CI head SHA projections", async (t) => {
  const eventStore = new TaskEventStore();
  const projectedHeadShas = [];
  const tasks = [
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 21,
        branch: "feature/ambiguous-ci",
      }),
      id: githubTaskId,
      identifier: "github:oxnw/agentrail:issues/21",
    },
  ];
  const server = createServer({
    store: eventStore,
    githubWebhookSecret: "github-secret",
    taskLifecycleStore: {
      listRawTasks: () => tasks,
      getRawTask: (taskId) => tasks.find((task) => task.id === taskId) ?? null,
      async projectCiState(_taskId, observation) {
        projectedHeadShas.push(observation.headSha);
      },
    },
    ciStatusAdapter: {
      async getTaskCiStatus() {
        return {
          data: {
            overallStatus: "passed",
            summary: { total: 1, passed: 1, failed: 0, running: 0, queued: 0, cancelled: 0, skipped: 0 },
            failureSummaries: [],
            updatedAt: "2026-05-08T00:00:00Z",
            headSha: null,
          },
        };
      },
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const payload = {
    repository: { owner: { login: "oxnw" }, name: "agentrail" },
    workflow_run: {
      head_branch: "feature/ambiguous-ci",
      head_sha: "sha-ambiguous-event",
    },
  };
  const rawBody = JSON.stringify(payload);
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`,
    },
    body: rawBody,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(projectedHeadShas, [null]);
});

test("POST /providers/github/webhooks projects pull request review decisions to matching tasks", async (t) => {
  const eventStore = new TaskEventStore();
  const projected = [];
  const tasks = [
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 21,
        pullNumber: 42,
      }),
      id: githubTaskId,
      identifier: "github:oxnw/agentrail:issues/21",
    },
  ];
  const server = createServer({
    store: eventStore,
    githubWebhookSecret: "github-secret",
    taskLifecycleStore: {
      listRawTasksBySourceRepo: () => tasks,
      async projectReviewState(taskId, observation) {
        projected.push({ taskId, observation });
      },
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const payload = {
    repository: { owner: { login: "oxnw" }, name: "agentrail" },
    pull_request: { number: 42, head: { sha: "current-pr-head-sha" } },
    review: {
      state: "changes_requested",
      body: "Please fix the failing test.",
      submitted_at: "2026-05-12T09:30:00Z",
      user: { login: "reviewer" },
      commit_id: "reviewed-commit-sha",
    },
  };
  const rawBody = JSON.stringify(payload);
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`,
    },
    body: rawBody,
  });

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(body.data.matchedTasks, [githubTaskId]);
  assert.deepEqual(projected, [
    {
      taskId: githubTaskId,
      observation: {
        outcome: "changes_requested",
        summary: "Please fix the failing test.",
        reviewer: "reviewer",
        updatedAt: "2026-05-12T09:30:00Z",
        headSha: "reviewed-commit-sha",
      },
    },
  ]);
});

test("POST /providers/github/webhooks projects PR-wide review decision when available", async (t) => {
  const eventStore = new TaskEventStore();
  const projected = [];
  const tasks = [
    {
      ...makeTask({
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 21,
        pullNumber: 42,
      }),
      id: githubTaskId,
      identifier: "github:oxnw/agentrail:issues/21",
    },
  ];
  const server = createServer({
    store: eventStore,
    githubWebhookSecret: "github-secret",
    reviewFeedbackAdapter: {
      async getTaskReviewFeedback(taskId) {
        assert.equal(taskId, githubTaskId);
        return {
          data: {
            latestDecision: {
              outcome: "changes_requested",
              summary: "Alice still has requested changes.",
              reviewer: { id: "alice", role: "member" },
              createdAt: "2026-05-12T09:25:00Z",
              headSha: "review-feedback-sha",
            },
          },
        };
      },
    },
    taskLifecycleStore: {
      listRawTasksBySourceRepo: () => tasks,
      async projectReviewState(taskId, observation) {
        projected.push({ taskId, observation });
      },
    },
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const payload = {
    repository: { owner: { login: "oxnw" }, name: "agentrail" },
    pull_request: { number: 42 },
    review: {
      state: "approved",
      body: "Looks good to me.",
      submitted_at: "2026-05-12T09:30:00Z",
      user: { login: "bob" },
    },
  };
  const rawBody = JSON.stringify(payload);
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/providers/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "github-secret").update(rawBody).digest("hex")}`,
    },
    body: rawBody,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(projected, [
    {
      taskId: githubTaskId,
      observation: {
        outcome: "changes_requested",
        summary: "Alice still has requested changes.",
        reviewer: "alice",
        updatedAt: "2026-05-12T09:25:00Z",
        headSha: "review-feedback-sha",
        decisionScope: "pull_request",
      },
    },
  ]);
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

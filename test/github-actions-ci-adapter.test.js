// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { GitHubActionsCiAdapter } from "../src/github-actions-ci-adapter.ts";

const taskId = "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V";

function makeTask(source) {
  return {
    id: taskId,
    identifier: "AGEA-101",
    title: "Persist provider metadata",
    description: "",
    status: "in_review",
    priority: "high",
    assignee: { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: [],
    links: { issue: "https://example.com/issues/101" },
    context: { project: "oxnw/agentrail", goal: "test" },
    updatedAt: "2026-05-05T12:00:00Z",
    availableActions: ["ship", "view_ci_status"],
    submissions: [],
    latestSubmissionId: null,
    ciStatus: null,
    reviewOutcome: null,
    shipOperation: null,
    rollbackOperation: null,
    dueAt: null,
    createdAt: "2026-05-05T12:00:00Z",
    version: 1,
    source: {
      provider: "github",
      ...source,
    },
  };
}

test("GitHubActionsCiAdapter summarizes multiple workflow files and failed test details", async () => {
  const fetchCalls = [];
  const adapter = new GitHubActionsCiAdapter({
    githubToken: "ghs_test_token",
    getTask: () => makeTask({
      owner: "oxnw",
      repo: "agentrail",
      branch: "feature/ci-status",
      headSha: "abc123",
      submissionId: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
    }),
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options });

      if (String(url).includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1201,
              name: "CI",
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1201",
              head_sha: "abc123",
              updated_at: "2026-05-01T03:03:19Z",
              run_attempt: 1
            },
            {
              id: 1202,
              name: "Lint",
              path: ".github/workflows/lint.yml",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1202",
              head_sha: "abc123",
              updated_at: "2026-05-01T03:02:17Z",
              run_attempt: 1
            },
            {
              id: 1199,
              name: "CI",
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1199",
              head_sha: "abc123",
              updated_at: "2026-05-01T02:58:01Z",
              run_attempt: 1
            }
          ]
        });
      }

      if (String(url).endsWith("/actions/runs/1201/jobs?per_page=100")) {
        return jsonResponse({
          jobs: [
            {
              id: 11,
              name: "unit-tests",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1201/job/11",
              started_at: "2026-05-01T03:02:00Z",
              completed_at: "2026-05-01T03:02:42Z"
            },
            {
              id: 12,
              name: "contract-tests",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1201/job/12",
              started_at: "2026-05-01T03:02:05Z",
              completed_at: null
            }
          ]
        });
      }

      if (String(url).endsWith("/actions/runs/1202/jobs?per_page=100")) {
        return jsonResponse({
          jobs: [
            {
              id: 21,
              name: "eslint",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1202/job/21",
              started_at: "2026-05-01T03:01:55Z",
              completed_at: "2026-05-01T03:02:07Z"
            }
          ]
        });
      }

      if (String(url).endsWith("/actions/runs/1199/jobs?per_page=100")) {
        return jsonResponse({
          jobs: [
            {
              id: 10,
              name: "unit-tests",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1199/job/10",
              started_at: "2026-05-01T02:57:10Z",
              completed_at: "2026-05-01T02:57:52Z"
            }
          ]
        });
      }

      if (String(url).endsWith("/actions/jobs/11/logs")) {
        return textResponse(`not ok 1 - GET /tasks/{id}/ci-status returns structured failures
  ---
  error: |-
    Expected status 200 but received 500
  stack: |-
    at TestContext.<anonymous> (test/ci-status-endpoint.test.js:44:10)
  ...`);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const body = await adapter.getTaskCiStatus(taskId);

  assert.equal(body.data.taskId, taskId);
  assert.equal(body.data.submissionId, "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2");
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
  assert.deepEqual(
    body.data.workflows.map((workflow) => [workflow.name, workflow.path, workflow.status]),
    [
      ["CI", ".github/workflows/ci.yml", "failed"],
      ["Lint", ".github/workflows/lint.yml", "passed"]
    ]
  );
  assert.deepEqual(
    body.data.checks.map((check) => [check.name, check.workflow, check.status, check.failureCount]),
    [
      ["unit-tests", "CI", "failed", 1],
      ["contract-tests", "CI", "running", 0],
      ["eslint", "Lint", "passed", 0]
    ]
  );
  assert.deepEqual(body.data.failureSummaries, [
    {
      checkName: "unit-tests",
      workflow: "CI",
      testName: "GET /tasks/{id}/ci-status returns structured failures",
      file: "test/ci-status-endpoint.test.js",
      line: 44,
      message: "Expected status 200 but received 500"
    }
  ]);
  assert.deepEqual(body.data.flakyHints, [
    {
      checkName: "unit-tests",
      confidence: "medium",
      reason: "same check passed on a previous run for this head SHA"
    }
  ]);
  assert.equal(body.data.updatedAt, "2026-05-01T03:03:19Z");
  assert.deepEqual(body.availableActions, ["retry_failed_checks", "view_logs"]);
  assert.equal(body.meta.tokenBudgetHint, "standard");
  assert.equal(JSON.stringify(body).includes("stack: |-"), false);
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer ghs_test_token");
});

test("GitHubActionsCiAdapter keeps green responses compact", async () => {
  const adapter = new GitHubActionsCiAdapter({
    getTask: () => makeTask({
      owner: "oxnw",
      repo: "agentrail",
      branch: "main",
      headSha: "def456",
      submissionId: "sub_green",
    }),
    fetch: async (url) => {
      if (String(url).includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2201,
              name: "CI",
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/2201",
              head_sha: "def456",
              updated_at: "2026-05-01T04:03:19Z",
              run_attempt: 1
            }
          ]
        });
      }

      if (String(url).endsWith("/actions/runs/2201/jobs?per_page=100")) {
        return jsonResponse({
          jobs: [
            {
              id: 31,
              name: "unit-tests",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/2201/job/31",
              started_at: "2026-05-01T04:02:00Z",
              completed_at: "2026-05-01T04:02:11Z"
            }
          ]
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const body = await adapter.getTaskCiStatus(taskId);

  assert.equal(body.data.overallStatus, "passed");
  assert.deepEqual(body.data.failureSummaries, []);
  assert.deepEqual(body.data.flakyHints, []);
  assert.deepEqual(body.availableActions, ["view_review_feedback"]);
  assert.equal(body.meta.tokenBudgetHint, "compact");
  assert.ok(JSON.stringify(body).length < 1200);
});

test("GitHubActionsCiAdapter resolves CI source from persisted task state", async () => {
  const adapter = new GitHubActionsCiAdapter({
    getTask: () => ({
      id: taskId,
      identifier: "AGEA-101",
      title: "Persist PR metadata",
      description: "",
      status: "in_review",
      priority: "high",
      assignee: { id: "agt_test", name: "Test Agent" },
      acceptanceCriteria: [],
      links: { issue: "https://example.com/issues/101" },
      context: { project: "oxnw/agentrail", goal: "test" },
      updatedAt: "2026-05-05T12:00:00Z",
      availableActions: ["ship", "view_ci_status"],
      submissions: [
        {
          id: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
          summary: "Persist submit state",
          artifacts: [],
          checks: [],
          notes: null,
          submittedAt: "2026-05-05T12:00:00Z",
          prUrl: "https://github.com/oxnw/agentrail/pull/42",
          prNumber: 42,
        },
      ],
      latestSubmissionId: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
      ciStatus: null,
      reviewOutcome: null,
      shipOperation: null,
      rollbackOperation: null,
      dueAt: null,
      createdAt: "2026-05-05T12:00:00Z",
      version: 2,
      source: {
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        branch: "feature/ci-status",
        headSha: "abc123",
      },
    }),
    fetch: async (url) => {
      if (String(url).includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1201,
              name: "CI",
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1201",
              head_sha: "abc123",
              updated_at: "2026-05-01T03:03:19Z",
              run_attempt: 1,
            },
          ],
        });
      }

      if (String(url).endsWith("/actions/runs/1201/jobs?per_page=100")) {
        return jsonResponse({
          jobs: [
            {
              id: 11,
              name: "unit-tests",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/oxnw/agentrail/actions/runs/1201/job/11",
              started_at: "2026-05-01T03:02:00Z",
              completed_at: "2026-05-01T03:02:42Z",
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const body = await adapter.getTaskCiStatus(taskId);

  assert.equal(body.data.taskId, taskId);
  assert.equal(body.data.submissionId, "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2");
  assert.equal(body.data.overallStatus, "passed");
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

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "text/plain"]]),
    async json() {
      throw new Error("Text response does not support json()");
    },
    async text() {
      return body;
    }
  };
}

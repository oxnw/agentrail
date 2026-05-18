// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { CircleCiStatusAdapter } from "../src/circleci-status-adapter.ts";
import {
  circleCiTaskId,
  circleCiTaskSource,
  currentBuildJobsResponse,
  currentLintJobsResponse,
  currentWorkflowListResponse,
  failedUnitTestsResponse,
  jobCompletedWebhook,
  pipelineListResponse,
  priorBuildJobsResponse,
  priorWorkflowListResponse,
  workflowCompletedWebhook
} from "./fixtures/circleci-fixtures.js";

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

test("CircleCiStatusAdapter summarizes workflows, failed tests, and flaky hints from CircleCI", async () => {
  const fetchCalls = [];
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(circleCiTaskSource),
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse(pipelineListResponse);
      }

      if (String(url).endsWith("/pipeline/pipeline-current/workflow")) {
        return jsonResponse(currentWorkflowListResponse);
      }

      if (String(url).endsWith("/pipeline/pipeline-prior/workflow")) {
        return jsonResponse(priorWorkflowListResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-current/job")) {
        return jsonResponse(currentBuildJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-lint-current/job")) {
        return jsonResponse(currentLintJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-prior/job")) {
        return jsonResponse(priorBuildJobsResponse);
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse(failedUnitTestsResponse);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const body = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(body.data.taskId, circleCiTaskId);
  assert.equal(body.data.submissionId, "sub_circleci_01");
  assert.equal(body.data.headSha, "abc123");
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
      ["build", null, "failed"],
      ["lint", null, "passed"]
    ]
  );
  assert.deepEqual(
    body.data.checks.map((check) => [check.name, check.workflow, check.status, check.failureCount]),
    [
      ["unit-tests", "build", "failed", 1],
      ["contract-tests", "build", "running", 0],
      ["eslint", "lint", "passed", 0]
    ]
  );
  assert.deepEqual(body.data.failureSummaries, [
    {
      checkName: "unit-tests",
      workflow: "build",
      testName: "GET /tasks/{id}/ci-status returns structured failures",
      file: "test/ci-status-endpoint.test.js",
      line: null,
      message: "Expected status 200 but received 500"
    }
  ]);
  assert.deepEqual(body.data.flakyHints, [
    {
      checkName: "unit-tests",
      confidence: "medium",
      reason: "same check passed on a previous pipeline for this head SHA"
    }
  ]);
  assert.equal(body.data.updatedAt, "2026-05-02T10:04:00Z");
  assert.deepEqual(body.availableActions, ["retry_failed_checks", "view_logs"]);
  assert.equal(body.meta.tokenBudgetHint, "standard");
  assert.equal(fetchCalls[0].options.headers["Circle-Token"], "circleci_test_token");
});

test("CircleCiStatusAdapter returns REST pipeline revision when task source lacks head SHA", async () => {
  const { headSha, ...sourceWithoutHeadSha } = circleCiTaskSource;
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(sourceWithoutHeadSha),
    fetch: async (url) => {
      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse(pipelineListResponse);
      }

      if (String(url).endsWith("/pipeline/pipeline-current/workflow")) {
        return jsonResponse(currentWorkflowListResponse);
      }

      if (String(url).endsWith("/pipeline/pipeline-prior/workflow")) {
        return jsonResponse(priorWorkflowListResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-current/job")) {
        return jsonResponse(currentBuildJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-lint-current/job")) {
        return jsonResponse(currentLintJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-prior/job")) {
        return jsonResponse(priorBuildJobsResponse);
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse(failedUnitTestsResponse);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const body = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(body.data.headSha, "abc123");
});

test("CircleCiStatusAdapter reuses webhook snapshots instead of polling pipelines again", async () => {
  const fetchCalls = [];
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    webhookSecret: "super-secret",
    getTask: () => makeTask(circleCiTaskSource),
    listTasks: () => [makeTask(circleCiTaskSource)],
    fetch: async (url) => {
      fetchCalls.push(String(url));

      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse(failedUnitTestsResponse);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  await adapter.receiveWebhook({
    headers: { "circleci-signature": signatureFor(workflowCompletedWebhook, "super-secret") },
    rawBody: JSON.stringify(workflowCompletedWebhook)
  });
  await adapter.receiveWebhook({
    headers: { "circleci-signature": signatureFor(jobCompletedWebhook, "super-secret") },
    rawBody: JSON.stringify(jobCompletedWebhook)
  });

  const body = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(body.data.overallStatus, "failed");
  assert.deepEqual(body.data.summary, {
    total: 1,
    passed: 0,
    failed: 1,
    running: 0,
    queued: 0,
    cancelled: 0,
    skipped: 0
  });
  assert.equal(fetchCalls.some((url) => url.includes("/project/gh/oxnw/agentrail/pipeline?")), false);
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

function signatureFor(payload, secret) {
  return `v1=${createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex")}`;
}

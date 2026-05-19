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
  pipelineListResponseWithoutVcs,
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

test("CircleCiStatusAdapter matches pipeline-run API metadata when CircleCI omits vcs fields", async () => {
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(circleCiTaskSource),
    fetch: async (url) => {
      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse(pipelineListResponseWithoutVcs);
      }

      if (String(url).endsWith("/pipeline/pipeline-current/workflow")) {
        return jsonResponse(currentWorkflowListResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-current/job")) {
        return jsonResponse(currentBuildJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-lint-current/job")) {
        return jsonResponse(currentLintJobsResponse);
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse(failedUnitTestsResponse);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const body = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(body.data.headSha, "abc123");
  assert.equal(body.data.overallStatus, "failed");
  assert.equal(body.data.workflows.length, 2);
});

test("CircleCiStatusAdapter triggers an API pipeline when no branch pipeline exists", async () => {
  const fetchCalls = [];
  const source = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(source),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET", body: options.body });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        return jsonResponse({
          id: "pipeline-triggered",
          number: 89,
          state: "pending",
          created_at: "2026-05-02T10:05:00Z",
        }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const body = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.deepEqual(fetchCalls.map((call) => [call.method, call.url]), [
    ["GET", "https://circleci.com/api/v2/project/gh/oxnw/agentrail/pipeline?branch=feature%2Fcircleci-status"],
    ["POST", "https://circleci.com/api/v2/project/gh/oxnw/agentrail/pipeline/run"],
  ]);
  assert.deepEqual(JSON.parse(fetchCalls[1].body), {
    definition_id: "definition-01",
    config: { branch: "feature/circleci-status" },
    checkout: { branch: "feature/circleci-status" },
  });
  assert.equal(body.data.overallStatus, "queued");
  assert.equal(body.data.headSha, "abc123");
  assert.deepEqual(body.availableActions, ["refresh"]);
});

test("CircleCiStatusAdapter retries API pipeline triggers after a failed trigger attempt", async () => {
  const fetchCalls = [];
  const source = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  let triggerAttempts = 0;
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(source),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET" });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        triggerAttempts += 1;
        if (triggerAttempts === 1) {
          return jsonResponse({ message: "temporary CircleCI failure" }, 502);
        }
        return jsonResponse({ id: "pipeline-triggered" }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await assert.rejects(
    () => adapter.getTaskCiStatus(circleCiTaskId),
    /CircleCI source rejected the request/,
  );

  const retry = await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(retry.data.overallStatus, "queued");
  assert.equal(fetchCalls.filter((call) => call.method === "POST").length, 2);
});

test("CircleCiStatusAdapter does not repeatedly trigger the same API pipeline", async () => {
  const fetchCalls = [];
  const source = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(source),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET" });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        return jsonResponse({ id: "pipeline-triggered" }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await adapter.getTaskCiStatus(circleCiTaskId);
  await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(fetchCalls.filter((call) => call.method === "POST").length, 1);
});

test("CircleCiStatusAdapter allows an API pipeline trigger again after the dedupe TTL expires", async () => {
  const fetchCalls = [];
  let now = 1_000;
  const source = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(source),
    triggeredPipelineKeyTtlMs: 100,
    now: () => now,
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET" });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        return jsonResponse({ id: "pipeline-triggered" }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await adapter.getTaskCiStatus(circleCiTaskId);
  now += 50;
  await adapter.getTaskCiStatus(circleCiTaskId);
  now += 51;
  await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(fetchCalls.filter((call) => call.method === "POST").length, 2);
});

test("CircleCiStatusAdapter evicts old successful API trigger keys when the cache reaches its size limit", async () => {
  const fetchCalls = [];
  let headSha = "sha-a";
  const source = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask({ ...source, headSha }),
    triggeredPipelineKeyMaxEntries: 2,
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET" });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        return jsonResponse({ id: `pipeline-triggered-${headSha}` }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await adapter.getTaskCiStatus(circleCiTaskId);
  headSha = "sha-b";
  await adapter.getTaskCiStatus(circleCiTaskId);
  headSha = "sha-c";
  await adapter.getTaskCiStatus(circleCiTaskId);
  headSha = "sha-a";
  await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(fetchCalls.filter((call) => call.method === "POST").length, 4);
});

test("CircleCiStatusAdapter records a clear trigger key sentinel when task source lacks head SHA", async () => {
  const fetchCalls = [];
  const { headSha, ...sourceWithoutHeadSha } = {
    ...circleCiTaskSource,
    circleciTriggerMode: "api",
    circleciPipelineDefinitionId: "definition-01",
  };
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(sourceWithoutHeadSha),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: options.method ?? "GET" });

      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse({ items: [] });
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/pipeline/run")) {
        return jsonResponse({ id: "pipeline-triggered" }, 201);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  await adapter.getTaskCiStatus(circleCiTaskId);

  assert.equal(adapter.triggeredPipelineKeys.has("gh/oxnw/agentrail:feature/circleci-status:<no-head-sha>:definition-01"), true);
});

test("CircleCiStatusAdapter refreshes workflow job state across repeated polls", async () => {
  let buildJobsResponse = currentBuildJobsResponse;
  let lintJobsResponse = currentLintJobsResponse;
  let workflowListResponse = currentWorkflowListResponse;
  const adapter = new CircleCiStatusAdapter({
    circleciToken: "circleci_test_token",
    getTask: () => makeTask(circleCiTaskSource),
    fetch: async (url) => {
      if (String(url).includes("/project/gh/oxnw/agentrail/pipeline?")) {
        return jsonResponse(pipelineListResponseWithoutVcs);
      }

      if (String(url).endsWith("/pipeline/pipeline-current/workflow")) {
        return jsonResponse(workflowListResponse);
      }

      if (String(url).endsWith("/workflow/workflow-build-current/job")) {
        return jsonResponse(buildJobsResponse);
      }

      if (String(url).endsWith("/workflow/workflow-lint-current/job")) {
        return jsonResponse(lintJobsResponse);
      }

      if (String(url).endsWith("/project/gh/oxnw/agentrail/101/tests")) {
        return jsonResponse(failedUnitTestsResponse);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const first = await adapter.getTaskCiStatus(circleCiTaskId);
  assert.equal(first.data.overallStatus, "failed");

  workflowListResponse = {
    items: currentWorkflowListResponse.items.map((workflow) => ({
      ...workflow,
      status: "success",
      stopped_at: "2026-05-02T10:06:00Z",
    })),
  };
  buildJobsResponse = {
    items: currentBuildJobsResponse.items.map((job) => ({
      ...job,
      status: "success",
      stopped_at: job.stopped_at ?? "2026-05-02T10:05:59Z",
    })),
  };
  lintJobsResponse = currentLintJobsResponse;

  const second = await adapter.getTaskCiStatus(circleCiTaskId);
  assert.equal(second.data.overallStatus, "passed");
  assert.deepEqual(second.data.summary, {
    total: 3,
    passed: 3,
    failed: 0,
    running: 0,
    queued: 0,
    cancelled: 0,
    skipped: 0,
  });
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

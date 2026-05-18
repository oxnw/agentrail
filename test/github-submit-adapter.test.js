// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { GitHubSubmitAdapter, extractIdempotencyKey, IDEMPOTENCY_TAG } from "../src/github-submit-adapter.ts";

const taskId = "tsk_DEMOISSUETOSHIP01";
const idempotencyKey = "idem-key-001";

function makeTask(overrides = {}) {
  return {
    id: taskId,
    identifier: "AGEA-101",
    title: "Submit provider-backed task",
    description: "",
    status: "assigned",
    priority: "high",
    assignee: { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: [],
    links: { issue: "https://github.com/acme/webapp/issues/42" },
    context: { project: "acme/webapp", goal: "test" },
    updatedAt: "2026-05-05T12:00:00Z",
    availableActions: ["submit"],
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
      owner: "acme",
      repo: "webapp",
      branch: "feat/fix-auth",
      baseBranch: "main",
      issueNumber: 42,
      reviewers: ["reviewer1"],
      ...overrides,
    },
  };
}

function makePR(overrides = {}) {
  return {
    number: 7,
    html_url: "https://github.com/acme/webapp/pull/7",
    title: "Submit tsk_DEMOISSUETOSHIP01",
    state: "open",
    draft: false,
    created_at: "2026-05-03T01:00:00Z",
    body: "",
    head: { ref: "feat/fix-auth" },
    base: { ref: "main" },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("creates a real GitHub PR via POST /repos/{owner}/{repo}/pulls", async () => {
  const fetchCalls = [];
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), method: options?.method ?? "GET" });

      if (String(url).includes("/pulls") && options?.method === "POST" && !String(url).includes("requested_reviewers")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/requested_reviewers")) {
        return jsonResponse({ requested_reviewers: [{ login: "reviewer1" }] });
      }
      if (String(url).includes("/comments") && options?.method === "POST") {
        return jsonResponse({ id: 100 });
      }
      if (String(url).includes("/pulls?state=all")) {
        return jsonResponse([]);
      }
      if (String(url).includes("/pulls?")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.submitTask(
    taskId,
    { summary: "Fixed auth", artifacts: [{ type: "commit", sha: "abc" }] },
    idempotencyKey,
  );

  assert.equal(result.data.action, "created");
  assert.equal(result.data.prUrl, pr.html_url);
  assert.equal(result.data.prNumber, 7);
  assert.equal(result.data.idempotencyKey, idempotencyKey);
  assert.equal(result.data.status, "in_review");

  const createCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"));
  assert.ok(createCall, "should call POST /repos/{owner}/{repo}/pulls");

  const reviewerCall = fetchCalls.find((c) => c.url.includes("/requested_reviewers"));
  assert.ok(reviewerCall, "should request reviewers");

  const commentCall = fetchCalls.find((c) => c.url.includes("/issues/42/comments"));
  assert.ok(commentCall, "should post issue comment recording PR URL");
});

test("resolves submit source from persisted routed task when not configured in task sources", async () => {
  const fetchCalls = [];
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: (requestedTaskId) => {
      assert.equal(requestedTaskId, taskId);
      return {
        id: taskId,
        source: {
          owner: "acme",
          repo: "webapp",
          branch: "feat/routed-task",
          baseBranch: "main",
          issueNumber: 42,
        },
        submissions: [],
        latestSubmissionId: null,
      };
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), method: options?.method ?? "GET" });

      if (String(url).includes("/pulls") && options?.method === "POST" && !String(url).includes("requested_reviewers")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/comments") && options?.method === "POST") {
        return jsonResponse({ id: 100 });
      }
      if (String(url).includes("/pulls?")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.submitTask(
    taskId,
    { summary: "Submitted routed task" },
    "idem-routed-submit",
  );

  assert.equal(result.data.action, "created");
  assert.equal(result.data.prNumber, 7);
  assert.ok(fetchCalls.some((call) => call.method === "POST" && call.url.endsWith("/pulls")));
});

test("uses the connected GitHub repo for Linear-backed tasks that submit pull requests", async () => {
  const fetchCalls = [];
  const pr = makePR({
    html_url: "https://github.com/oxnw/agentrail-e2e-sandbox/pull/74",
    head: { ref: "agentrail/linear-e2e", sha: "linear-sha-1" },
  });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    repos: [{ slug: "oxnw/agentrail-e2e-sandbox", defaultBranch: "main" }],
    getTask: (requestedTaskId) => {
      assert.equal(requestedTaskId, taskId);
      return {
        id: taskId,
        source: {
          provider: "linear",
          linearIssueId: "lin_123",
          linearIdentifier: "TES-6",
          branch: "agentrail/linear-e2e",
        },
        submissions: [],
        latestSubmissionId: null,
      };
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), method: options?.method ?? "GET" });
      if (String(url).includes("/pulls") && options?.method === "POST" && !String(url).includes("requested_reviewers")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/pulls?")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.submitTask(
    taskId,
    { summary: "Submit Linear-backed task" },
    "idem-linear-submit-001",
  );

  assert.equal(result.data.owner, "oxnw");
  assert.equal(result.data.repo, "agentrail-e2e-sandbox");
  assert.equal(result.data.ciProvider, "github_actions");
  assert.ok(fetchCalls.some((call) => call.url.includes("/repos/oxnw/agentrail-e2e-sandbox/pulls")));
});

test("preserves CircleCI metadata when submitting a GitHub-backed PR", async () => {
  const pr = makePR({
    head: { ref: "feat/fix-auth", sha: "circleci-sha-1" },
  });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask({
      ciProvider: "circleci",
      projectSlug: "circleci/org-id/project-id",
    }),
    fetch: async (url, options) => {
      if (String(url).includes("/pulls") && options?.method === "POST" && !String(url).includes("requested_reviewers")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/requested_reviewers")) {
        return jsonResponse({ requested_reviewers: [{ login: "reviewer1" }] });
      }
      if (String(url).includes("/comments") && options?.method === "POST") {
        return jsonResponse({ id: 100 });
      }
      if (String(url).includes("/pulls?state=all")) {
        return jsonResponse([]);
      }
      if (String(url).includes("/pulls?")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.submitTask(taskId, { summary: "Keep CircleCI wiring" }, "idem-circleci-submit");

  assert.equal(result.data.ciProvider, "circleci");
  assert.equal(result.data.headSha, "circleci-sha-1");
});

test("returns existing PR without creating a duplicate (idempotent replay)", async () => {
  const pr = makePR();
  let createCallCount = 0;

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async (url, options) => {
      if (String(url).includes("/pulls") && options?.method === "POST" && !String(url).includes("requested_reviewers")) {
        createCallCount++;
        return jsonResponse(pr);
      }
      if (String(url).includes("/requested_reviewers")) {
        return jsonResponse({ requested_reviewers: [] });
      }
      if (String(url).includes("/comments") && options?.method === "POST") {
        return jsonResponse({ id: 100 });
      }
      if (String(url).includes("/pulls?")) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    },
  });

  const payload = { summary: "Fixed auth", artifacts: [{ type: "commit", sha: "abc" }] };

  const first = await adapter.submitTask(taskId, payload, "idem-replay-001");
  assert.equal(first.data.action, "created");
  assert.equal(createCallCount, 1);

  const second = await adapter.submitTask(taskId, payload, "idem-replay-001");
  assert.equal(second.data.action, "created");
  assert.equal(second.data.prUrl, pr.html_url);
  assert.equal(createCallCount, 1, "should NOT call GitHub again on replay");
});

test("rejects mismatched payload on same idempotency key with 409", async () => {
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async (url, options) => {
      if (options?.method === "POST" && String(url).endsWith("/pulls")) return jsonResponse(pr);
      if (String(url).includes("/requested_reviewers")) return jsonResponse({ requested_reviewers: [] });
      if (String(url).includes("/comments") && options?.method === "POST") return jsonResponse({ id: 1 });
      if (String(url).includes("/pulls?")) return jsonResponse([]);
      return jsonResponse({});
    },
  });

  await adapter.submitTask(
    taskId,
    { summary: "First", artifacts: [{ type: "commit", sha: "a" }] },
    "idem-conflict-001",
  );

  await assert.rejects(
    () => adapter.submitTask(taskId, { summary: "Different", artifacts: [{ type: "commit", sha: "b" }] }, "idem-conflict-001"),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
});

test("finds existing PR by idempotency key embedded in body", async () => {
  const existingPR = makePR({
    body: `Closes #42\n\nFixed it\n\n${IDEMPOTENCY_TAG} idem-existing-001 -->`,
  });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async (url) => {
      if (String(url).includes("/pulls?state=all")) {
        return jsonResponse([existingPR]);
      }
      return jsonResponse([]);
    },
  });

  const result = await adapter.submitTask(
    taskId,
    { summary: "Fixed", artifacts: [{ type: "commit", sha: "x" }] },
    "idem-existing-001",
  );

  assert.equal(result.data.action, "existing");
  assert.equal(result.data.prNumber, 7);
});

test("finds existing PR by head branch match", async () => {
  const existingPR = makePR({ body: "Some PR" });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async (url) => {
      if (String(url).includes("/pulls?state=all")) {
        return jsonResponse([]);
      }
      if (String(url).includes("/pulls?state=open")) {
        return jsonResponse([existingPR]);
      }
      return jsonResponse([]);
    },
  });

  const result = await adapter.submitTask(
    taskId,
    { summary: "Fixed", artifacts: [{ type: "commit", sha: "x" }] },
    "idem-branch-001",
  );

  assert.equal(result.data.action, "existing");
  assert.equal(result.data.prNumber, 7);
});

test("delegates to the fallback lifecycle store when no task source exists", async () => {
  let delegateCalled = false;
  const delegate = {
    submitTask: async () => {
      delegateCalled = true;
      return { data: { submissionId: "sub_DEMO", taskId: "tsk_other" }, availableActions: [] };
    },
  };

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => null,
    fetch: async () => jsonResponse({}),
    delegate,
  });

  await adapter.submitTask("tsk_other", { summary: "test", artifacts: [{}] }, "key1");
  assert.ok(delegateCalled, "should delegate to the fallback lifecycle store");
});

test("requires Idempotency-Key header", async () => {
  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: () => makeTask(),
    fetch: async () => jsonResponse({}),
  });

  await assert.rejects(
    () => adapter.submitTask(taskId, { summary: "test", artifacts: [{}] }, null),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("extractIdempotencyKey round-trip", () => {
  const key = "my-key-789";
  const body = `Some PR body\n\n${IDEMPOTENCY_TAG} ${key} -->`;
  assert.equal(extractIdempotencyKey(body), key);
  assert.equal(extractIdempotencyKey("no key here"), null);
});

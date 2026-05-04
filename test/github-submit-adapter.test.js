// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { GitHubSubmitAdapter, extractIdempotencyKey, IDEMPOTENCY_TAG } from "../src/github-submit-adapter.js";

const taskId = "tsk_DEMOISSUETOSHIP01";
const idempotencyKey = "idem-key-001";

function makeTaskSources(overrides = {}) {
  return new Map([
    [
      taskId,
      {
        owner: "acme",
        repo: "webapp",
        branch: "feat/fix-auth",
        baseBranch: "main",
        issueNumber: 42,
        reviewers: ["reviewer1"],
        ...overrides,
      },
    ],
  ]);
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
    taskSources: makeTaskSources(),
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

test("returns existing PR without creating a duplicate (idempotent replay)", async () => {
  const pr = makePR();
  let createCallCount = 0;

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
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
    taskSources: makeTaskSources(),
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
    taskSources: makeTaskSources(),
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
    taskSources: makeTaskSources(),
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

test("delegates to demo store when no task source exists", async () => {
  let delegateCalled = false;
  const delegate = {
    submitTask: async () => {
      delegateCalled = true;
      return { data: { submissionId: "sub_DEMO", taskId: "tsk_other" }, availableActions: [] };
    },
  };

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: new Map(),
    fetch: async () => jsonResponse({}),
    delegate,
  });

  await adapter.submitTask("tsk_other", { summary: "test", artifacts: [{}] }, "key1");
  assert.ok(delegateCalled, "should delegate to demo store");
});

test("requires Idempotency-Key header", async () => {
  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
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

test("surfaces reviewer assignment failure as warnings and re-attempts on replay", async () => {
  const pr = makePR();
  let reviewerCallCount = 0;

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url, options) => {
      if (options?.method === "POST" && String(url).endsWith("/pulls")) return jsonResponse(pr);
      if (String(url).includes("/requested_reviewers")) {
        reviewerCallCount++;
        if (reviewerCallCount === 1) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
        }
        return jsonResponse({ requested_reviewers: [{ login: "reviewer1" }] });
      }
      if (String(url).includes("/comments") && options?.method === "POST") return jsonResponse({ id: 1 });
      if (String(url).includes("/pulls?")) return jsonResponse([]);
      return jsonResponse({});
    },
  });

  const payload = { summary: "Fixed auth", artifacts: [{ type: "commit", sha: "abc" }] };

  const first = await adapter.submitTask(taskId, payload, "idem-reviewer-001");
  assert.equal(first.data.action, "created");
  assert.ok(first.data.warnings, "should include warnings on first attempt");
  assert.equal(first.data.warnings[0].code, "reviewer_assignment_failed");
  assert.equal(reviewerCallCount, 1);

  const second = await adapter.submitTask(taskId, payload, "idem-reviewer-001");
  assert.equal(second.data.action, "created");
  assert.equal(reviewerCallCount, 2, "should re-attempt reviewer assignment on replay");
  assert.ok(!second.data.warnings, "should clear warnings after successful retry");
});

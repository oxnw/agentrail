// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { GitHubSubmitAdapter } from "../src/github-submit-adapter.js";

const taskId = "tsk_DEMOISSUETOSHIP01";
const idempotencyKey = "idem-ship-001";

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
        prNumber: 7,
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
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: null,
    head: { sha: "abc123def456" },
    ...overrides,
  };
}

function makeIssue(overrides = {}) {
  return {
    number: 42,
    html_url: "https://github.com/acme/webapp/issues/42",
    state: "open",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("shipTask merges PR and closes issue (happy path)", async () => {
  const fetchCalls = [];
  const pr = makePR();
  const issue = makeIssue();
  const mergeResult = { sha: "merge-sha-789" };

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), method: options?.method ?? "GET" });

      if (String(url).includes("/pulls/7") && !String(url).includes("/merge")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/pulls/7/merge")) {
        return jsonResponse(mergeResult);
      }
      if (String(url).includes("/issues/42") && options?.method === "PATCH") {
        return jsonResponse({ ...issue, state: "closed" });
      }
      if (String(url).includes("/issues/42")) {
        return jsonResponse(issue);
      }
      if (String(url).includes("/commits/abc123def456/status")) {
        return jsonResponse({ state: "success" });
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.shipTask(
    taskId,
    { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
    idempotencyKey,
  );

  assert.equal(result.data.status, "merged");
  assert.equal(result.data.prNumber, 7);
  assert.equal(result.data.mergeCommitSha, "merge-sha-789");
  assert.deepEqual(result.data.availableActions, ["rollback"]);
  assert.deepEqual(result.availableActions, ["rollback"]);

  const mergeCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/merge"));
  assert.ok(mergeCall, "should call PUT /repos/{owner}/{repo}/pulls/{pr}/merge");

  const closeIssueCall = fetchCalls.find((c) => c.method === "PATCH" && c.url.includes("/issues/42"));
  assert.ok(closeIssueCall, "should PATCH issue to closed");
});

test("shipTask returns merged status without re-attempting when PR already merged (idempotent replay)", async () => {
  const fetchCalls = [];
  const pr = makePR({ merged: true, merge_commit_sha: "already-merged-sha" });
  const issue = makeIssue({ state: "closed" });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url) => {
      fetchCalls.push({ url: String(url), method: "GET" });

      if (String(url).includes("/pulls/7")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/issues/42")) {
        return jsonResponse(issue);
      }
      return jsonResponse({});
    },
  });

  const result = await adapter.shipTask(
    taskId,
    { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
    idempotencyKey,
  );

  assert.equal(result.data.status, "merged");
  assert.equal(result.data.mergeCommitSha, "already-merged-sha");
  assert.equal(result.data.issueState, "closed");

  const mergeCall = fetchCalls.find((c) => c.method === "PUT" && c.url.includes("/merge"));
  assert.ok(!mergeCall, "should NOT call merge when already merged");
});

test("shipTask rejects mismatched payload on same idempotency key with 409", async () => {
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url) => {
      if (String(url).includes("/pulls/7")) return jsonResponse(pr);
      if (String(url).includes("/commits/")) return jsonResponse({ state: "success" });
      return jsonResponse({});
    },
  });

  await adapter.shipTask(
    taskId,
    { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
    "idem-conflict-001",
  );

  await assert.rejects(
    () => adapter.shipTask(
      taskId,
      { mode: "merge", targetEnvironment: "staging", expectedHeadSha: "abc123def456" },
      "idem-conflict-001",
    ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "conflict");
      return true;
    },
  );
});

test("shipTask returns 409 when CI is failing", async () => {
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url) => {
      if (String(url).includes("/pulls/7")) return jsonResponse(pr);
      if (String(url).includes("/commits/abc123def456/status")) {
        return jsonResponse({ state: "failure" });
      }
      return jsonResponse({});
    },
  });

  await assert.rejects(
    () => adapter.shipTask(
      taskId,
      { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
      "idem-ci-fail-001",
    ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "ci_failing");
      assert.ok(err.message.includes("CI checks are failing"));
      return true;
    },
  );
});

test("shipTask returns 409 when review is required (405 from GitHub)", async () => {
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url, options) => {
      if (String(url).includes("/pulls/7") && !String(url).includes("/merge")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/pulls/7/merge")) {
        return jsonResponse({ message: "Required status check is expected" }, 405);
      }
      if (String(url).includes("/commits/")) {
        return jsonResponse({ state: "success" });
      }
      return jsonResponse({});
    },
  });

  await assert.rejects(
    () => adapter.shipTask(
      taskId,
      { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
      "idem-review-001",
    ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "review_required");
      assert.ok(err.message.includes("approved review"));
      return true;
    },
  );
});

test("shipTask returns 409 when PR has merge conflicts", async () => {
  const pr = makePR({ mergeable: false, mergeable_state: "dirty" });

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url) => {
      if (String(url).includes("/pulls/7")) return jsonResponse(pr);
      return jsonResponse({});
    },
  });

  await assert.rejects(
    () => adapter.shipTask(
      taskId,
      { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
      "idem-conflict-001",
    ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "merge_conflict");
      assert.ok(err.message.includes("merge conflicts"));
      return true;
    },
  );
});

test("shipTask returns 403 when user has insufficient permission", async () => {
  const pr = makePR();

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async (url, options) => {
      if (String(url).includes("/pulls/7") && !String(url).includes("/merge")) {
        return jsonResponse(pr);
      }
      if (String(url).includes("/pulls/7/merge")) {
        return jsonResponse({ message: "Forbidden" }, 403);
      }
      if (String(url).includes("/commits/")) {
        return jsonResponse({ state: "success" });
      }
      return jsonResponse({});
    },
  });

  await assert.rejects(
    () => adapter.shipTask(
      taskId,
      { mode: "merge", targetEnvironment: "production", expectedHeadSha: "abc123def456" },
      "idem-perm-001",
    ),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, "insufficient_permission");
      assert.ok(err.message.includes("permission"));
      return true;
    },
  );
});

test("shipTask delegates to demo store when no task source exists", async () => {
  let delegateCalled = false;
  const delegate = {
    shipTask: async () => {
      delegateCalled = true;
      return { data: { operationId: "op_DELEGATED", taskId, status: "merged" }, availableActions: ["rollback"] };
    },
  };

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: new Map(),
    fetch: async () => jsonResponse({}),
    delegate,
  });

  await adapter.shipTask("tsk_other", { mode: "merge" }, "key1");
  assert.ok(delegateCalled, "should delegate to demo store");
});

test("shipTask requires Idempotency-Key header", async () => {
  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources(),
    fetch: async () => jsonResponse({}),
  });

  await assert.rejects(
    () => adapter.shipTask(taskId, { mode: "merge" }, null),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "validation_error");
      return true;
    },
  );
});

test("shipTask requires prNumber when not in task source", async () => {
  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    taskSources: makeTaskSources({ prNumber: undefined }),
    fetch: async () => jsonResponse({}),
  });

  await assert.rejects(
    () => adapter.shipTask(taskId, { mode: "merge" }, "key1"),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "validation_error");
      assert.ok(err.message.includes("prNumber"));
      return true;
    },
  );
});

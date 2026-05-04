// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { GitHubShipAdapter } from "../src/github-ship-adapter.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

const expectedHeadSha = "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0";

function makeAdapter(overrides = {}) {
  const fetchCalls = [];
  const eventStore = { append: async () => {} };
  const adapter = new GitHubShipAdapter({
    taskSources: new Map([
      ["tsk_gh42", { owner: "acme", repo: "webapp", issueNumber: 42, branch: "feature-42", prNumber: 7 }]
    ]),
    githubToken: "ghs_test_token",
    apiBaseUrl: "https://github.mock",
    eventStore,
    now: () => new Date("2026-05-04T12:00:00Z"),
    publicBaseUrl: "http://localhost:3000",
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return overrides.fetch?.(url, options) ?? jsonResponse({});
    },
  });
  adapter._fetchCalls = fetchCalls;
  return adapter;
}

test("shipTask merges an open PR with matching head SHA", async () => {
  const mergeResult = { sha: "abc123def4567890abc123def4567890abc123de" };
  const adapter = makeAdapter({
    fetch: (url) => {
      if (String(url).endsWith("/pulls/7")) {
        return jsonResponse({ number: 7, state: "open", head: { sha: expectedHeadSha }, merge_commit_sha: null });
      }
      if (String(url).endsWith("/pulls/7/merge")) {
        return jsonResponse(mergeResult, 200);
      }
      return jsonResponse({});
    }
  });

  const result = await adapter.shipTask("tsk_gh42", {
    mode: "merge_only",
    targetEnvironment: "production",
    expectedHeadSha
  }, "idem_ship_1");

  assert.equal(result.data.status, "succeeded");
  assert.equal(result.data.taskId, "tsk_gh42");
  assert.ok(result.data.operationId.startsWith("shp_gh_"));
  assert.deepEqual(result.data.availableActions, ["rollback"]);
  assert.deepEqual(result.availableActions, ["rollback"]);
});

test("shipTask requires Idempotency-Key header", async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", { mode: "merge_only", targetEnvironment: "production", expectedHeadSha }, undefined),
    (err) => err.statusCode === 400 && err.code === "validation_error"
  );
});

test("shipTask rejects reused idempotency key with different payload", async () => {
  const adapter = makeAdapter({
    fetch: async () => jsonResponse({ number: 7, state: "open", head: { sha: expectedHeadSha } })
  });

  const payload = { mode: "merge_only", targetEnvironment: "production", expectedHeadSha };
  await adapter.shipTask("tsk_gh42", payload, "idem_conflict");
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", { ...payload, targetEnvironment: "staging" }, "idem_conflict"),
    (err) => err.statusCode === 409 && err.code === "conflict"
  );
});

test("shipTask replays idempotent result for same key and payload", async () => {
  const adapter = makeAdapter({
    fetch: async () => jsonResponse({ number: 7, state: "open", head: { sha: expectedHeadSha } })
  });
  const payload = { mode: "merge_only", targetEnvironment: "production", expectedHeadSha };
  const first = await adapter.shipTask("tsk_gh42", payload, "idem_replay");
  const second = await adapter.shipTask("tsk_gh42", payload, "idem_replay");
  assert.equal(first.data.operationId, second.data.operationId);
});

test("shipTask returns succeeded when PR is already merged", async () => {
  const adapter = makeAdapter({
    fetch: async () => jsonResponse({ number: 7, state: "closed", merged: true, merge_commit_sha: "abc123" })
  });
  const payload = { mode: "merge_only", targetEnvironment: "production", expectedHeadSha };
  const result = await adapter.shipTask("tsk_gh42", payload, "idem_merged");
  assert.equal(result.data.status, "succeeded");
});

test("shipTask throws 409 when head SHA mismatch", async () => {
  const adapter = makeAdapter({
    fetch: async () => jsonResponse({ number: 7, state: "open", head: { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } })
  });
  const payload = { mode: "merge_only", targetEnvironment: "production", expectedHeadSha };
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", payload, "idem_sha"),
    (err) => err.statusCode === 409 && err.code === "conflict"
  );
});

test("shipTask throws 405 conflict when merge is blocked", async () => {
  const adapter = makeAdapter({
    fetch: (url) => {
      if (String(url).endsWith("/pulls/7")) {
        return jsonResponse({ number: 7, state: "open", head: { sha: expectedHeadSha }, merge_commit_sha: null });
      }
      if (String(url).endsWith("/pulls/7/merge")) {
        return jsonResponse({ message: "Not mergeable" }, 405);
      }
      return jsonResponse({});
    }
  });
  const payload = { mode: "merge_only", targetEnvironment: "production", expectedHeadSha };
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", payload, "idem_blocked"),
    (err) => err.statusCode === 409 && err.message.includes("cannot be merged")
  );
});

test("shipTask delegates to demo store when no source configured", async () => {
  const demoShip = { data: { taskId: "tsk_demo", operationId: "shp_demo", status: "succeeded", queuedAt: new Date().toISOString(), availableActions: ["rollback"] }, availableActions: ["rollback"] };
  const adapter = new GitHubShipAdapter({
    taskSources: new Map(),
    delegate: { shipTask: async () => demoShip },
    publicBaseUrl: "http://localhost:3000",
  });
  const result = await adapter.shipTask("tsk_demo", { mode: "merge_only", targetEnvironment: "staging", expectedHeadSha }, "id_key");
  assert.equal(result.data.operationId, "shp_demo");
});

test("shipTask validates payload fields", async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", { mode: "invalid", targetEnvironment: "production", expectedHeadSha }, "idx1"),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", { mode: "merge_only", targetEnvironment: "prod", expectedHeadSha }, "idx2"),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => adapter.shipTask("tsk_gh42", { mode: "merge_only", targetEnvironment: "production", expectedHeadSha: "too-short" }, "idx3"),
    (err) => err.statusCode === 400
  );
});

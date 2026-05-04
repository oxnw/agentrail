// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/app.js";
import { createAgentShipCycleDemoStore, DEMO_HEAD_SHA } from "../src/agent-ship-cycle-demo.js";
import { TaskEventStore } from "../src/task-event-store.js";
import { GitHubRollbackAdapter } from "../src/github-rollback-adapter.js";
import { createMockGitHubServer } from "./mock-github-server.js";

const mockGithubUrl = "http://127.0.0.1:9998";
const taskId = "tsk_DEMOISSUETOSHIP01";
const REVERT_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function buildMockGitHubServer() {
  return createMockGitHubServer({
    port: 9998,
    responses: {
      [`GET /repos/acme/webapp/git/commits/${DEMO_HEAD_SHA}`]: () => ({
        status: 200,
        body: {
          sha: DEMO_HEAD_SHA,
          message: "feat: awesome feature",
          parents: [{ sha: "parent1111parent1111parent1111parent1111parent1111" }],
        },
      }),
      "POST /repos/acme/webapp/git/commits": () => ({
        status: 201,
        body: { sha: REVERT_SHA, message: "Revert..." },
      }),
      "GET /repos/acme/webapp/git/commits/parent1111parent1111parent1111parent1111parent1111": () => ({
        status: 200,
        body: { sha: "parent1111parent1111parent1111parent1111parent1111", tree: { sha: "tree1234" } },
      }),
      "POST /repos/acme/webapp/git/refs": () => ({
        status: 201,
        body: { ref: `refs/heads/rollback/${DEMO_HEAD_SHA.slice(0, 8)}` },
      }),
      "POST /repos/acme/webapp/pulls": () => ({
        status: 201,
        body: {
          number: 99,
          html_url: "https://github.com/acme/webapp/pull/99",
          title: "Rollback PR",
          state: "open",
          draft: false,
          created_at: new Date().toISOString(),
          head: { ref: `rollback/${DEMO_HEAD_SHA.slice(0, 8)}` },
          base: { ref: "main" },
        },
      }),
      "PATCH /repos/acme/webapp/issues/42": () => ({
        status: 200,
        body: { number: 42, state: "open" },
      }),
    },
  });
}

async function startTestServer() {
  const now = () => new Date("2026-05-04T00:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const demoStore = createAgentShipCycleDemoStore({ now, eventStore });

  const taskSources = new Map([
    [
      taskId,
      {
        owner: "acme",
        repo: "webapp",
        branch: "feat/fix-auth",
        baseBranch: "main",
        issueNumber: 42,
        mergedSha: DEMO_HEAD_SHA,
      },
    ],
  ]);

  const rollbackAdapter = new GitHubRollbackAdapter({
    taskSources,
    githubToken: "ghs_test",
    apiBaseUrl: mockGithubUrl,
    fetch: globalThis.fetch,
  });

  const server = createServer({
    store: eventStore,
    taskLifecycleStore: demoStore,
    ciStatusAdapter: demoStore,
    reviewFeedbackAdapter: demoStore,
    rollbackAdapter,
    now,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, rollbackAdapter, demoStore };
}

async function shipDemoTask(baseUrl) {
  await fetch(`${baseUrl}/tasks/${taskId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "submit-1" },
    body: JSON.stringify({
      summary: "First submission",
      artifacts: [{ type: "pull_request", url: "https://github.com/example/pr/1" }],
    }),
  });

  await fetch(`${baseUrl}/tasks/${taskId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "submit-2" },
    body: JSON.stringify({
      summary: "Fixed idempotency",
      artifacts: [{ type: "pull_request", url: "https://github.com/example/pr/1" }],
      checks: [{ name: "unit-tests", status: "passed" }],
    }),
  });

  await fetch(`${baseUrl}/tasks/${taskId}/ship`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "ship-1" },
    body: JSON.stringify({
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha: DEMO_HEAD_SHA,
    }),
  });
}

test("POST /tasks/{id}/rollback routes through GitHubRollbackAdapter when configured", async () => {
  const mockGithub = buildMockGitHubServer();
  await mockGithub.start();

  const { server, baseUrl } = await startTestServer();

  try {
    await shipDemoTask(baseUrl);

    const res = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rollback-integration-001",
      },
      body: JSON.stringify({ reason: "Production regression" }),
    });

    assert.equal(res.status, 202, `Expected 202, got ${res.status}`);
    const json = await res.json();

    assert.equal(json.data.status, "rollback_pr_created");
    assert.ok(json.data.rollbackPrUrl);
    assert.ok(json.data.newHeadSha);
    assert.equal(json.data.revertedCommitSha, DEMO_HEAD_SHA);

    const requests = mockGithub.getRequests();
    const getCommit = requests.find(
      (r) => r.method === "GET" && r.path === `/repos/acme/webapp/git/commits/${DEMO_HEAD_SHA}`
    );
    assert.ok(getCommit, "GitHub API should have received GET git/commits/{sha}");

    const createCommit = requests.find(
      (r) => r.method === "POST" && r.path === "/repos/acme/webapp/git/commits"
    );
    assert.ok(createCommit, "GitHub API should have received POST git/commits");

    const createRef = requests.find(
      (r) => r.method === "POST" && r.path === "/repos/acme/webapp/git/refs"
    );
    assert.ok(createRef, "GitHub API should have received POST git/refs");

    const createPr = requests.find(
      (r) => r.method === "POST" && r.path === "/repos/acme/webapp/pulls"
    );
    assert.ok(createPr, "GitHub API should have received POST pulls");
    assert.equal(createPr.body.head, `rollback/${DEMO_HEAD_SHA.slice(0, 8)}`);

    const reopenIssue = requests.find(
      (r) => r.method === "PATCH" && r.path === "/repos/acme/webapp/issues/42"
    );
    assert.ok(reopenIssue, "GitHub API should have received PATCH issues/42");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

test("POST /tasks/{id}/rollback rejects live rollback before task exposes rollback action", async () => {
  const mockGithub = buildMockGitHubServer();
  await mockGithub.start();

  const now = () => new Date("2026-05-04T00:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const demoStore = createAgentShipCycleDemoStore({ now, eventStore });

  const taskSources = new Map([
    [
      taskId,
      {
        owner: "acme",
        repo: "webapp",
        branch: "feat/fix-auth",
        baseBranch: "main",
        issueNumber: 42,
        mergedSha: DEMO_HEAD_SHA,
      },
    ],
  ]);

  const rollbackAdapter = new GitHubRollbackAdapter({
    taskSources,
    githubToken: "ghs_test",
    apiBaseUrl: mockGithubUrl,
    fetch: globalThis.fetch,
  });

  const server = createServer({
    store: eventStore,
    taskLifecycleStore: demoStore,
    ciStatusAdapter: demoStore,
    reviewFeedbackAdapter: demoStore,
    rollbackAdapter,
    now,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rollback-before-ship",
      },
      body: JSON.stringify({ reason: "Should be blocked" }),
    });

    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error.code, "conflict");

    const requests = mockGithub.getRequests();
    assert.equal(requests.length, 0, "Rollback must not call GitHub before task is shipped");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

test("POST /tasks/{id}/rollback is idempotent end-to-end through GitHubRollbackAdapter", async () => {
  const mockGithub = buildMockGitHubServer();
  await mockGithub.start();

  const { server, baseUrl } = await startTestServer();

  try {
    await shipDemoTask(baseUrl);

    const idempotencyKey = "rollback-idem-integration-001";
    const payload = JSON.stringify({ reason: "Rollback needed" });

    const res1 = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: payload,
    });
    assert.equal(res1.status, 202);
    const json1 = await res1.json();
    assert.equal(json1.data.status, "rollback_pr_created");

    // Clear mock to prove idempotency skips external calls
    mockGithub.clearRequests();

    const res2 = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: payload,
    });
    assert.equal(res2.status, 202);
    const json2 = await res2.json();

    assert.deepEqual(json1, json2, "Idempotent replay should return identical response");

    const requests = mockGithub.getRequests();
    assert.equal(requests.length, 0, "Should not call GitHub API on idempotent replay");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

test("POST /tasks/{id}/rollback falls back to demo store when task source is missing", async () => {
  const mockGithub = buildMockGitHubServer();
  await mockGithub.start();

  const now = () => new Date("2026-05-04T00:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const demoStore = createAgentShipCycleDemoStore({ now, eventStore });

  const rollbackAdapter = new GitHubRollbackAdapter({
    taskSources: new Map(),
    githubToken: "ghs_test",
    apiBaseUrl: mockGithubUrl,
    fetch: globalThis.fetch,
    delegate: demoStore,
  });

  const server = createServer({
    store: eventStore,
    taskLifecycleStore: demoStore,
    ciStatusAdapter: demoStore,
    reviewFeedbackAdapter: demoStore,
    rollbackAdapter,
    now,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await shipDemoTask(baseUrl);

    const res = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rollback-fallback-001" },
      body: JSON.stringify({ reason: "Fallback test" }),
    });

    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.data.status, "rollback_pr_created");

    // Should not have called GitHub API because source was missing and delegate handled it
    const requests = mockGithub.getRequests();
    assert.equal(requests.length, 0, "Should not call GitHub API when task source is missing and delegate is used");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

test("POST /tasks/{id}/rollback idempotency rejects reused key with different payload", async () => {
  const mockGithub = buildMockGitHubServer();
  await mockGithub.start();

  const { server, baseUrl } = await startTestServer();

  try {
    await shipDemoTask(baseUrl);

    const idempotencyKey = "rollback-conflict-integration-001";

    await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ reason: "First reason" }),
    });

    const res2 = await fetch(`${baseUrl}/tasks/${taskId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ reason: "Different reason" }),
    });

    assert.equal(res2.status, 409);
    const json2 = await res2.json();
    assert.equal(json2.error.code, "conflict");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

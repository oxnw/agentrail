// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/app.ts";
import { createMockGitHubServer } from "./mock-github-server.js";
import { TaskEventStore } from "../src/task-event-store.ts";
import { GitHubSubmitAdapter } from "../src/github-submit-adapter.ts";
import { createAgentShipCycleDemoStore } from "./helpers/deterministic-lifecycle-store.ts";

const taskId = "tsk_DEMOISSUETOSHIP01";
const mockGithubUrl = "http://127.0.0.1:9999";

async function startTestServer() {
  const now = () => new Date("2026-05-04T00:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const demoStore = createAgentShipCycleDemoStore({ now, eventStore });

  const task = demoStore.getExistingTask(taskId);
  assert.ok(task);
  task.source = {
    provider: "github",
    owner: "acme",
    repo: "webapp",
    branch: "feat/fix-auth",
    baseBranch: "main",
    issueNumber: 42,
    reviewers: ["reviewer1"],
  };
  demoStore.tasks.set(taskId, task);

  const adapter = new GitHubSubmitAdapter({
    githubToken: "ghs_test",
    getTask: demoStore.getExistingTask.bind(demoStore),
    delegate: demoStore,
    apiBaseUrl: mockGithubUrl,
    fetch: globalThis.fetch,
  });
  const taskLifecycleStore = {
    listMyTasks: demoStore.listMyTasks.bind(demoStore),
    getTask: demoStore.getTask.bind(demoStore),
    getTaskCiStatus: demoStore.getTaskCiStatus.bind(demoStore),
    getTaskReviewFeedback: demoStore.getTaskReviewFeedback.bind(demoStore),
    shipTask: demoStore.shipTask.bind(demoStore),
    rollbackTask: demoStore.rollbackTask.bind(demoStore),
    submitTask: adapter.submitTask.bind(adapter),
  };

  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    ciStatusAdapter: demoStore,
    reviewFeedbackAdapter: demoStore,
    now,
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return { server, baseUrl, adapter };
}

test("POST /tasks/{id}/submit creates a real PR end-to-end", async () => {
  const mockGithub = createMockGitHubServer({ port: 9999 });
  await mockGithub.start();

  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/tasks/${taskId}/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "integration-test-001",
      },
      body: JSON.stringify({
        summary: "Testing the full submit flow",
        mode: "adapter_managed",
        pullRequest: {
          title: "Integration Test PR",
          body: "Testing the full submit flow",
        },
      }),
    });

    assert.equal(res.status, 202, `Expected 202, got ${res.status}`);
    const json = await res.json();

    assert.equal(json.data.action, "created");
    assert.equal(json.data.status, "in_review");
    assert.ok(json.data.prUrl?.includes("github.com/acme/webapp/pull/"));
    assert.ok(Number.isInteger(json.data.prNumber));

    const requests = mockGithub.getRequests();
    const createPR = requests.find((r) => r.method === "POST" && r.path === "/repos/acme/webapp/pulls");
    assert.ok(createPR, "GitHub API should have received POST /repos/acme/webapp/pulls");
    assert.equal(createPR.body.title, "Integration Test PR");
    assert.equal(createPR.body.head, "feat/fix-auth");
    assert.equal(createPR.body.base, "main");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

test("POST /tasks/{id}/submit is idempotent end-to-end", async () => {
  const mockGithub = createMockGitHubServer({ port: 9999 });
  await mockGithub.start();

  const { server, baseUrl } = await startTestServer();

  try {
    const idempotencyKey = "idem-integration-001";
    const payload = JSON.stringify({ title: "Idempotent PR", body: "test" });

    // First submit
    const res1 = await fetch(`${baseUrl}/tasks/${taskId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: payload,
    });
    assert.equal(res1.status, 202);
    const json1 = await res1.json();
    assert.equal(json1.data.action, "created");
    const firstPrNumber = json1.data.prNumber;

    // Reset mock to track second request
    mockGithub.clearRequests();

    // Second submit with same key
    const res2 = await fetch(`${baseUrl}/tasks/${taskId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: payload,
    });
    assert.equal(res2.status, 202);
    const json2 = await res2.json();

    assert.equal(json2.data.action, "created");
    assert.equal(json2.data.prNumber, firstPrNumber);

    // Should NOT have called GitHub API again
    const requests = mockGithub.getRequests();
    const createCalls = requests.filter((r) => r.method === "POST" && r.path === "/repos/acme/webapp/pulls");
    assert.equal(createCalls.length, 0, "Should not call GitHub API on idempotent replay");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mockGithub.stop();
  }
});

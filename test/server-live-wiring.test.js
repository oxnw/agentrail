// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

import { createMockGitHubServer } from "./mock-github-server.js";

const mergedSha = "0123456789abcdef0123456789abcdef01234567";

test("src/server wires live GitHub task discovery and review feedback when configured", async (t) => {
  const githubPort = await getFreePort();
  const appPort = await getFreePort();
  const githubBaseUrl = `http://127.0.0.1:${githubPort}`;

  const mockGithub = createMockGitHubServer({
    port: githubPort,
    responses: {
      "GET /repos/acme/webapp/issues": () => ({
        status: 200,
        body: [
          {
            number: 42,
            title: "Validate live provider wiring",
            state: "open",
            labels: [{ name: "in progress" }, { name: "priority: high" }],
            assignees: [{ login: "tester" }],
            html_url: "https://github.com/acme/webapp/issues/42",
            updated_at: "2026-05-04T17:00:00Z",
            body: "## Acceptance Criteria\n- Server uses live GitHub issue data.",
          },
        ],
      }),
      "GET /repos/acme/webapp/issues/42": () => ({
        status: 200,
        body: {
          number: 42,
          title: "Validate live provider wiring",
          state: "open",
          labels: [{ name: "in review" }, { name: "priority: high" }],
          assignees: [{ login: "tester" }],
          html_url: "https://github.com/acme/webapp/issues/42",
          updated_at: "2026-05-04T17:00:00Z",
          body: "## Acceptance Criteria\n- Server uses live GitHub issue data.",
        },
      }),
      "GET /repos/acme/webapp/pulls/7/reviews": () => ({
        status: 200,
        body: [
          {
            id: 701,
            state: "APPROVED",
            body: "Looks good.",
            submitted_at: "2026-05-04T17:05:00Z",
            author_association: "MEMBER",
            user: { login: "reviewer1" },
          },
        ],
      }),
      "GET /repos/acme/webapp/pulls/7/comments": () => ({
        status: 200,
        body: [],
      }),
      "GET /repos/acme/webapp/issues/7/comments": () => ({
        status: 200,
        body: [],
      }),
    },
  });

  await mockGithub.start();

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTRAIL_HOST: "127.0.0.1",
      AGENTRAIL_PORT: String(appPort),
      AGENTRAIL_PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`,
      AGENTRAIL_TASK_SOURCES: JSON.stringify({
        tsk_gh42: {
          owner: "acme",
          repo: "webapp",
          issueNumber: 42,
          pullNumber: 7,
          branch: "feat/live-provider-wiring",
          baseBranch: "main",
          mergedSha,
        },
      }),
      GITHUB_API_BASE_URL: githubBaseUrl,
      GITHUB_ASSIGNEE_LOGIN: "tester",
      GITHUB_TOKEN: "ghs_test_token",
      CIRCLECI_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    child.kill("SIGTERM");
    await mockGithub.stop();
  });

  await waitForServer(child, appPort);

  const baseUrl = `http://127.0.0.1:${appPort}`;

  const mine = await getJson(`${baseUrl}/tasks/mine?limit=5`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data[0].i, "tsk_gh42");
  assert.equal(mine.body.data[0].t, "Validate live provider wiring");

  const detail = await getJson(`${baseUrl}/tasks/tsk_gh42`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.links.issue, "https://github.com/acme/webapp/issues/42");
  assert.equal(detail.body.data.status, "in_review");

  const review = await getJson(`${baseUrl}/tasks/tsk_gh42/review-feedback`);
  assert.equal(review.status, 200);
  assert.equal(review.body.data.latestDecision.outcome, "approved");
  assert.equal(review.body.data.latestDecision.reviewer.id, "reviewer1");

  const requests = mockGithub.getRequests();
  assert.ok(
    requests.some((r) => r.method === "GET" && r.path === "/repos/acme/webapp/issues"),
    "server should query GitHub issues for /tasks/mine"
  );
  assert.ok(
    requests.some((r) => r.method === "GET" && r.path === "/repos/acme/webapp/pulls/7/reviews"),
    "server should query GitHub reviews for /review-feedback"
  );
});

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  return { status: response.status, body: await response.json() };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForServer(child, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`server did not start on port ${port}: ${stderr}`);
}

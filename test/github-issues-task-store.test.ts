// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { GitHubIssuesTaskStore } from "../src/github-issues-task-store.js";
import { TaskEventStore } from "../src/task-event-store.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  return { response, body };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

const mockIssues = Array.from({ length: 11 }).map((_, i) => ({
  number: 100 + i,
  title: `Issue ${i + 1}`,
  state: "open",
  labels: [i % 2 === 0 ? "in review" : "in progress"],
  assignees: [{ login: "tester" }],
  html_url: `https://github.com/demo-org/demo-repo/issues/${100 + i}`,
  updated_at: `2026-05-02T10:00:00Z`,
  body: null,
}));

function makeStore() {
  const fetchCalls = [];
  const store = new GitHubIssuesTaskStore({
    githubToken: "ghs_test_token",
    taskSources: new Map([
      ["tsk_gh100", { owner: "demo-org", repo: "demo-repo", issueNumber: 100 }],
    ]),
    fetch: async (url, options) => {
      fetchCalls.push({ url, options: { headers: options?.headers } });
      const match = String(url).match(/repos\/([^\/]+)\/([^\/]+)\/issues\?(.*)/);
      if (match) {
        const params = new URLSearchParams(match[3]);
        const perPage = Number(params.get("per_page") || "10");
        const page = Number(params.get("page") || "1");
        const start = (page - 1) * perPage;
        const pageSlice = mockIssues.slice(start, start + perPage);
        return jsonResponse(pageSlice);
      }
      if (String(url).endsWith("/issues/100")) {
        return jsonResponse(mockIssues[0]);
      }
      if (String(url).endsWith("/issues/404")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  store._fetchCalls = fetchCalls;
  return store;
}

test("listMyTasks fetches assigned open issues with compact fields and token budget <200", async (t) => {
  const store = makeStore();
  const result = await store.listMyTasks({ principal: { agent: { externalIdentities: [{ provider: "github", subject: "tester" }] } } });

  assert.equal(Array.isArray(result.data), true);
  assert.equal(result.data.length, 10);
  const first = result.data[0];
  assert.ok(first.i, "expected compact id field i");
  assert.ok(first.t, "expected compact title field t");
  assert.ok(first.s, "expected compact status field s");
  assert.ok(first.p, "expected compact priority field p");
  assert.equal(result.page.hasMore, true, "hasMore should be true when extra fetched");
  assert.ok(result.page.nextCursor, "nextCursor should be present");
  assert.equal(result.meta.tokenBudgetHint, "compact");

  // Token budget verification: serialize JSON and divide by 4 heuristic
  const payloadJson = JSON.stringify(result);
  const tokens = Math.ceil(payloadJson.length / 4);
  assert.ok(tokens < 200, `Expected <200 tokens, got ${tokens}`);
});

test("getTask fetches a single issue by synthetic taskId and returns structured detail", async (t) => {
  const store = makeStore();
  const body = await store.getTask("tsk_gh100");

  assert.equal(body.data.id, "tsk_gh100");
  assert.equal(body.data.title, "Issue 1");
  assert.equal(body.data.status, "in_review");
  assert.equal(body.data.priority, "medium");
  assert.equal(body.data.assignee.id, "gh_tester");
  assert.ok(body.data.links.issue);
  assert.equal(body.meta.tokenBudgetHint, "standard");
});

test("getTask returns 404 for unknown taskId", async (t) => {
  const store = makeStore();
  await assert.rejects(
    store.getTask("unknown_task_id"),
    (err) => { return err?.statusCode === 404 || err?.code === "not_found"; }
  );
});

test("app GET /tasks/mine delegates to live GitHubIssuesTaskStore", async (t) => {
  const now = () => new Date("2026-05-01T10:00:00Z");
  const store = makeStore();
  const server = createServer({
    store: new TaskEventStore({ now }),
    taskLifecycleStore: store,
    authStore: {
      authenticate() {
        return {
          keyId: "akey_test",
          agent: {
            id: "agt_test",
            displayName: "Test Agent",
            role: "agent",
            externalIdentities: [{ provider: "github", subject: "tester" }],
          },
          scopes: ["tasks:read"],
        };
      }
    },
    now,
  });
  t.after(async () => new Promise((resolve) => server.close(resolve)));

  const baseUrl = await listen(server);

  const mine = await requestJson(baseUrl, "/tasks/mine?limit=10", {
    headers: { authorization: "Bearer test_key" },
  });

  assert.equal(mine.response.status, 200);
  assert.equal(Array.isArray(mine.body.data), true);
  assert.equal(mine.body.data.length, 10);
  assert.equal(mine.body.page.hasMore, true);
  assert.ok(store._fetchCalls.some(c => String(c.url).includes("assignee=tester")), "should query GitHub with assignee");
});

test("app GET /tasks/{id} delegates to live GitHubIssuesTaskStore", async (t) => {
  const now = () => new Date("2026-05-01T10:00:00Z");
  const store = makeStore();
  const server = createServer({
    store: new TaskEventStore({ now }),
    taskLifecycleStore: store,
    authStore: {
      authenticate() {
        return {
          keyId: "akey_test",
          agent: {
            id: "agt_test",
            displayName: "Test Agent",
            role: "agent",
            externalIdentities: [{ provider: "github", subject: "tester" }],
          },
          scopes: ["tasks:read"],
        };
      }
    },
    now,
  });
  t.after(async () => new Promise((resolve) => server.close(resolve)));

  const baseUrl = await listen(server);

  const detail = await requestJson(baseUrl, "/tasks/tsk_gh100", {
    headers: { authorization: "Bearer test_key" },
  });

  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.id, "tsk_gh100");
  assert.equal(detail.body.data.status, "in_review");
});

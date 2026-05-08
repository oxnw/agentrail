import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntime, fetchAllGitHubIssues, fetchAllLinearIssues, parseNextLink } from "../src/server-runtime.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const now = () => new Date("2026-05-06T15:00:00.000Z");

test("buildRuntime starts without live provider configuration", () => {
  const runtime = buildRuntime({
    githubToken: null,
    circleciToken: null,
    now,
    eventStore: new TaskEventStore({ now }),
    publicBaseUrl: "http://127.0.0.1:3000",
  });

  assert.ok(runtime.taskLifecycleStore);
  assert.ok(runtime.routingControlPlane);
  assert.equal(runtime.ciStatusAdapter, null);
  assert.equal(runtime.reviewFeedbackAdapter, null);
  assert.equal(runtime.rollbackAdapter, null);
  assert.ok(runtime.intakeAdapter);
  assert.ok(runtime.linearIntakeAdapter);
  assert.ok(!("receiveWebhook" in runtime.linearIntakeAdapter));
  assert.equal(runtime.linearWebhookAdapter, null);
  assert.equal(runtime.deliveryController, null);
});

test("fetchAllGitHubIssues follows Link header pagination", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("page=2")) {
      return new Response(JSON.stringify([{ number: 2 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify([{ number: 1 }]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/repos/oxnw/agentrail/issues?state=all&per_page=100&page=2>; rel="next"',
      },
    });
  }) as typeof globalThis.fetch;

  try {
    const issues = await fetchAllGitHubIssues({
      owner: "oxnw",
      repo: "agentrail",
      token: "github-token",
      repoSlug: "oxnw/agentrail",
    });
    assert.deepEqual(issues.map((issue) => issue.number), [1, 2]);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchAllLinearIssues follows pageInfo pagination", async () => {
  const originalFetch = globalThis.fetch;
  const cursors: Array<string | null> = [];
  globalThis.fetch = (async (_url: string | URL, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    cursors.push(body.variables.after ?? null);
    if (body.variables.after === "cursor-1") {
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [{ id: "lin_issue_2", identifier: "ENG-2" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [{ id: "lin_issue_1", identifier: "ENG-1" }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  try {
    const issues = await fetchAllLinearIssues("linear-token");
    assert.deepEqual(issues.map((issue) => issue.identifier), ["ENG-1", "ENG-2"]);
    assert.deepEqual(cursors, [null, "cursor-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseNextLink extracts the next page URL", () => {
  assert.equal(
    parseNextLink('<https://example.com/page/2>; rel="next", <https://example.com/page/5>; rel="last"'),
    "https://example.com/page/2",
  );
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('<https://example.com/page/5>; rel="last"'), null);
  assert.equal(parseNextLink(""), null);
  assert.equal(parseNextLink('https://example.com/page/2; rel="next"'), null);
});

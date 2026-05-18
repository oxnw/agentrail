import test from "node:test";
import assert from "node:assert/strict";

import { ProviderCursorStore } from "../src/provider-cursor-store.ts";
import { buildRuntime, fetchAllGitHubIssues, fetchAllLinearIssues, parseNextLink, pollGitHubIssues } from "../src/server-runtime.ts";
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

test("buildRuntime submit adapter calls GitHub API, not AgentRail public base URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    assert.equal((options?.headers as Record<string, string> | undefined)?.authorization, "Bearer ghs_test");
    if (href.includes("/pulls?state=all")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail/pulls") {
      return new Response(JSON.stringify({
        number: 17,
        html_url: "https://github.com/oxnw/agentrail/pull/17",
        head: { ref: "benchmark/fix", sha: "abc123" },
        base: { ref: "main" },
        created_at: "2026-05-11T22:30:00Z",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as typeof globalThis.fetch;

  try {
    const runtime = buildRuntime({
      githubToken: "ghs_test",
      githubMode: "real",
      circleciToken: null,
      now,
      eventStore: new TaskEventStore({ now }),
      publicBaseUrl: "http://127.0.0.1:3144",
    });
    const task = runtime.taskLifecycleStore.createTask({
      identifier: "github:oxnw/agentrail:issues/15",
      title: "Benchmark issue",
      assignee: { id: "agt_test", name: "Test Agent" },
      assigneeAgentId: "agt_test",
      status: "in_progress",
      availableActions: ["submit"],
      source: {
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 15,
        baseBranch: "main",
      },
    });

    const response = await runtime.taskLifecycleStore.submitTask(task.id, {
      summary: "Submit benchmark issue",
      pullRequest: {
        head: "benchmark/fix",
        base: "main",
      },
    }, "runtime-submit-github-base");

    assert.equal((response as any).data.prUrl, "https://github.com/oxnw/agentrail/pull/17");
    assert.ok(calls.length > 0);
    assert.ok(calls.every((href) => href.startsWith("https://api.github.com/")), calls.join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildRuntime submits Linear-backed tasks against the configured connected GitHub repo", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    assert.equal((options?.headers as Record<string, string> | undefined)?.authorization, "Bearer ghs_test");
    if (href.includes("/pulls?state=all")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail-e2e-sandbox/pulls") {
      return new Response(JSON.stringify({
        number: 74,
        html_url: "https://github.com/oxnw/agentrail-e2e-sandbox/pull/74",
        head: { ref: "agentrail/linear-submit", sha: "linear-head-sha" },
        base: { ref: "main" },
        created_at: "2026-05-18T15:00:00Z",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as typeof globalThis.fetch;

  try {
    const runtime = buildRuntime({
      githubToken: "ghs_test",
      githubMode: "real",
      circleciToken: null,
      now,
      eventStore: new TaskEventStore({ now }),
      publicBaseUrl: "http://127.0.0.1:3144",
      repos: [{
        path: "/tmp/agentrail-e2e-sandbox",
        slug: "oxnw/agentrail-e2e-sandbox",
        defaultBranch: "main",
      }],
    });
    const task = runtime.taskLifecycleStore.createTask({
      identifier: "linear:tsting:issues/TES-6",
      title: "Linear benchmark issue",
      assignee: { id: "agt_test", name: "Test Agent" },
      assigneeAgentId: "agt_test",
      status: "in_progress",
      availableActions: ["submit"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_06",
        linearIdentifier: "TES-6",
        baseBranch: "main",
      },
    });

    const response = await runtime.taskLifecycleStore.submitTask(task.id, {
      summary: "Submit Linear issue",
      pullRequest: {
        head: "agentrail/linear-submit",
      },
    }, "runtime-submit-linear-base");

    const updated = runtime.taskLifecycleStore.getRawTask(task.id);
    assert.equal((response as any).data.prNumber, 74);
    assert.equal(updated?.source?.owner, "oxnw");
    assert.equal(updated?.source?.repo, "agentrail-e2e-sandbox");
    assert.equal(updated?.source?.ciProvider, "github_actions");
    assert.ok(calls.every((href) => href.startsWith("https://api.github.com/")), calls.join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildRuntime ship adapter merges through GitHub and records shipped task state", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ href: string; method: string }> = [];
  globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
    const href = String(url);
    const method = options?.method ?? "GET";
    calls.push({ href, method });
    assert.equal((options?.headers as Record<string, string> | undefined)?.authorization, "Bearer ghs_test");
    if (href === "https://api.github.com/repos/oxnw/agentrail/pulls/19") {
      return new Response(JSON.stringify({
        number: 19,
        html_url: "https://github.com/oxnw/agentrail/pull/19",
        state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        head: { ref: "agentrail/ship", sha: "head-sha-19" },
        base: { ref: "main" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail/commits/head-sha-19/status") {
      return new Response(JSON.stringify({ state: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail/pulls/19/merge") {
      assert.equal(method, "PUT");
      return new Response(JSON.stringify({ sha: "merge-sha-19", merged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail/issues/18" && method === "PATCH") {
      return new Response(JSON.stringify({ state: "closed", html_url: "https://github.com/oxnw/agentrail/issues/18" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === "https://api.github.com/repos/oxnw/agentrail/issues/18") {
      return new Response(JSON.stringify({ state: "closed", html_url: "https://github.com/oxnw/agentrail/issues/18" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as typeof globalThis.fetch;

  try {
    const eventStore = new TaskEventStore({ now });
    const runtime = buildRuntime({
      githubToken: "ghs_test",
      githubMode: "real",
      circleciToken: null,
      now,
      eventStore,
      publicBaseUrl: "http://127.0.0.1:3144",
    });
    const task = runtime.taskLifecycleStore.createTask({
      identifier: "github:oxnw/agentrail:issues/18",
      title: "Ship issue",
      assignee: { id: "agt_test", name: "Test Agent" },
      assigneeAgentId: "agt_test",
      status: "in_review",
      availableActions: ["ship", "view_ci_status", "view_review_feedback"],
      ciStatus: "passed",
      source: {
        provider: "github",
        owner: "oxnw",
        repo: "agentrail",
        issueNumber: 18,
        pullNumber: 19,
        branch: "agentrail/ship",
        baseBranch: "main",
        headSha: "head-sha-19",
      },
    });

    const response = await runtime.taskLifecycleStore.shipTask(task.id, { mergeMethod: "squash" }, "runtime-ship-github-base");
    const updated = runtime.taskLifecycleStore.getRawTask(task.id);

    assert.equal((response as any).data.operationId, "ghship_19");
    assert.equal(updated?.status, "done");
    assert.deepEqual(updated?.availableActions, ["rollback"]);
    assert.equal(updated?.shipOperation?.id, "ghship_19");
    assert.equal(updated?.source?.mergedSha, "merge-sha-19");
    assert.equal(eventStore.events.at(-1)?.type, "task.shipped");
    assert.ok(calls.length > 0);
    assert.ok(calls.every(({ href }) => href.startsWith("https://api.github.com/")), calls.map(({ href }) => href).join("\n"));
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("fetchAllGitHubIssues includes since while following Link header pagination", async () => {
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
        link: '<https://api.github.com/repos/oxnw/agentrail/issues?state=all&per_page=100&since=2026-05-14T12%3A00%3A00.000Z&page=2>; rel="next"',
      },
    });
  }) as typeof globalThis.fetch;

  try {
    const issues = await fetchAllGitHubIssues({
      owner: "oxnw",
      repo: "agentrail",
      token: "github-token",
      repoSlug: "oxnw/agentrail",
      since: "2026-05-14T12:00:00.000Z",
    });
    assert.deepEqual(issues.map((issue) => issue.number), [1, 2]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /since=2026-05-14T12%3A00%3A00\.000Z/u);
    assert.match(calls[1], /page=2/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollGitHubIssues in from_now mode seeds a cursor and avoids first-run historical import", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const ingestedIssues: number[] = [];
  const cursorStore = new ProviderCursorStore({
    now: () => new Date("2026-05-14T12:00:00.000Z"),
  });
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    fetchCalls.push(href);
    assert.match(href, /since=2026-05-14T12%3A00%3A00\.000Z/u);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const summary = await pollGitHubIssues({
      token: "github-token",
      repo: {
        path: "/tmp/agentrail",
        slug: "oxnw/agentrail",
        defaultBranch: "main",
      },
      intakeAdapter: {
        ingest: async (issue: { issueNumber: number }) => {
          ingestedIssues.push(issue.issueNumber);
          return { outcome: "created" };
        },
      } as any,
      cursorStore,
      importMode: "from_now",
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    assert.equal(summary.checked, 0);
    assert.deepEqual(ingestedIssues, []);
    assert.equal(fetchCalls.length, 1);
    assert.equal(cursorStore.getCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }), "2026-05-14T12:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollGitHubIssues in backfill mode imports first-run issues before writing a cursor", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const ingestedIssues: number[] = [];
  const cursorStore = new ProviderCursorStore({
    now: () => new Date("2026-05-14T12:00:00.000Z"),
  });
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    fetchCalls.push(href);
    assert.doesNotMatch(href, /[?&]since=/u);
    return new Response(JSON.stringify([{
      number: 7,
      html_url: "https://github.com/oxnw/agentrail/issues/7",
      title: "Historical issue",
      body: "",
      labels: [],
      state: "open",
      updated_at: "2026-05-10T09:00:00.000Z",
    }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const summary = await pollGitHubIssues({
      token: "github-token",
      repo: {
        path: "/tmp/agentrail",
        slug: "oxnw/agentrail",
        defaultBranch: "main",
      },
      intakeAdapter: {
        ingest: async (issue: { issueNumber: number }) => {
          ingestedIssues.push(issue.issueNumber);
          return { outcome: "created" };
        },
      } as any,
      cursorStore,
      importMode: "backfill",
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    assert.equal(summary.checked, 1);
    assert.deepEqual(ingestedIssues, [7]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(cursorStore.getCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }), "2026-05-14T12:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollGitHubIssues does not advance cursor when issue ingest fails", async () => {
  const originalFetch = globalThis.fetch;
  const cursorStore = new ProviderCursorStore({
    now: () => new Date("2026-05-14T12:00:00.000Z"),
  });
  cursorStore.setCursor(
    { provider: "github", resource: "issues", repository: "oxnw/agentrail" },
    "2026-05-14T11:00:00.000Z",
  );
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    number: 9,
    html_url: "https://github.com/oxnw/agentrail/issues/9",
    title: "Route me",
    body: "",
    labels: [],
    state: "open",
    updated_at: "2026-05-14T12:05:00.000Z",
  }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof globalThis.fetch;

  try {
    const summary = await pollGitHubIssues({
      token: "github-token",
      repo: {
        path: "/tmp/agentrail",
        slug: "oxnw/agentrail",
        defaultBranch: "main",
      },
      intakeAdapter: {
        ingest: async () => {
          throw new Error("routing store unavailable");
        },
      } as any,
      cursorStore,
      importMode: "from_now",
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    assert.equal(summary.failed, 1);
    assert.equal(cursorStore.getCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }), "2026-05-14T11:00:00.000Z");
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

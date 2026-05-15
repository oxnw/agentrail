import assert from "node:assert/strict";
import test from "node:test";

import { registerGitHubWebhook, verifyGitHubWebhookMetadata } from "../src/github-webhook-registration.ts";

test("registerGitHubWebhook creates a repo hook when no AgentRail webhook URL exists", async () => {
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [
        {
          id: 11,
          name: "web",
          active: true,
          events: ["push"],
          config: { url: "https://elsewhere.example.com/webhook" },
        },
      ],
    },
    {
      ok: true,
      status: 201,
      json: {
        id: 42,
        name: "web",
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      },
    },
  ]);

  const result = await registerGitHubWebhook({
    token: "ghp_registration_token",
    repoSlug: "oxnw/agentrail",
    webhookUrl: "https://agentrail.example.com/providers/github/webhooks",
    secret: "webhook-secret",
    fetch: fetch as any,
  });

  assert.equal(result.action, "created");
  assert.equal(result.hook.hookId, 42);
  assert.equal(result.hook.repoSlug, "oxnw/agentrail");
  assert.equal(result.hook.url, "https://agentrail.example.com/providers/github/webhooks");
  assert.deepEqual(result.hook.events, ["issues", "workflow_run", "pull_request_review"]);

  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100");
  assert.equal(fetch.calls[0]?.method, "GET");
  assert.equal(fetch.calls[1]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks");
  assert.equal(fetch.calls[1]?.method, "POST");
  assert.deepEqual(JSON.parse(fetch.calls[1]?.body ?? "{}"), {
    name: "web",
    active: true,
    events: ["issues", "workflow_run", "pull_request_review"],
    config: {
      url: "https://agentrail.example.com/providers/github/webhooks",
      content_type: "json",
      secret: "webhook-secret",
      insecure_ssl: "0",
    },
  });
});

test("registerGitHubWebhook updates an existing hook when the AgentRail webhook URL already exists", async () => {
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [
        {
          id: 77,
          name: "web",
          active: false,
          events: ["issues"],
          config: { url: "https://agentrail.example.com/providers/github/webhooks" },
        },
      ],
    },
    {
      ok: true,
      status: 200,
      json: {
        id: 77,
        name: "web",
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      },
    },
  ]);

  const result = await registerGitHubWebhook({
    token: "ghp_registration_token",
    repoSlug: "oxnw/agentrail",
    webhookUrl: "https://agentrail.example.com/providers/github/webhooks",
    secret: "rotated-secret",
    fetch: fetch as any,
  });

  assert.equal(result.action, "updated");
  assert.equal(result.hook.hookId, 77);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks/77");
  assert.equal(fetch.calls[1]?.method, "PATCH");
  assert.deepEqual(JSON.parse(fetch.calls[1]?.body ?? "{}"), {
    active: true,
    events: ["issues", "workflow_run", "pull_request_review"],
    config: {
      url: "https://agentrail.example.com/providers/github/webhooks",
      content_type: "json",
      secret: "rotated-secret",
      insecure_ssl: "0",
    },
  });
});

test("verifyGitHubWebhookMetadata rejects disabled hooks and hooks missing required events", async () => {
  const disabledFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: false,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);

  await assert.rejects(
    verifyGitHubWebhookMetadata({
      token: "ghp_registration_token",
      fetch: disabledFetch as any,
      metadata: [{
        repoSlug: "oxnw/agentrail",
        hookId: 42,
        url: "https://agentrail.example.com/providers/github/webhooks",
        events: ["issues", "workflow_run", "pull_request_review"],
        active: true,
      }],
    }),
    /disabled/u,
  );

  const missingEventsFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: true,
        events: ["issues"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);

  await assert.rejects(
    verifyGitHubWebhookMetadata({
      token: "ghp_registration_token",
      fetch: missingEventsFetch as any,
      metadata: [{
        repoSlug: "oxnw/agentrail",
        hookId: 42,
        url: "https://agentrail.example.com/providers/github/webhooks",
        events: ["issues", "workflow_run", "pull_request_review"],
        active: true,
      }],
    }),
    /missing events: workflow_run, pull_request_review/u,
  );
});

test("verifyGitHubWebhookMetadata requires canonical AgentRail webhook events even with stale metadata", async () => {
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: true,
        events: ["issues"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);

  await assert.rejects(
    verifyGitHubWebhookMetadata({
      token: "ghp_registration_token",
      fetch: fetch as any,
      metadata: [{
        repoSlug: "oxnw/agentrail",
        hookId: 42,
        url: "https://agentrail.example.com/providers/github/webhooks",
        events: ["issues"],
        active: true,
      }],
    }),
    /missing events: workflow_run, pull_request_review/u,
  );
});

test("registerGitHubWebhook finds and updates matching hooks on later pages", async () => {
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: [{
        id: 11,
        active: true,
        events: ["push"],
        config: { url: "https://elsewhere.example.com/webhook" },
      }],
      headers: {
        link: '<https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100&page=2>; rel="next"',
      },
    },
    {
      ok: true,
      status: 200,
      json: [{
        id: 77,
        active: false,
        events: ["issues"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
    {
      ok: true,
      status: 200,
      json: {
        id: 77,
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      },
    },
  ]);

  const result = await registerGitHubWebhook({
    token: "ghp_registration_token",
    repoSlug: "oxnw/agentrail",
    webhookUrl: "https://agentrail.example.com/providers/github/webhooks",
    secret: "rotated-secret",
    fetch: fetch as any,
  });

  assert.equal(result.action, "updated");
  assert.equal(result.hook.hookId, 77);
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[0]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100");
  assert.equal(fetch.calls[1]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100&page=2");
  assert.equal(fetch.calls[2]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks/77");
});

function createFetchStub(responses: Array<{
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const stub = async (
    url: string | URL,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const next = responses.shift();
    assert.ok(next, `unexpected fetch call for ${String(url)}`);
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body,
    });
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.json ?? {};
      },
      async text() {
        return next.text ?? "";
      },
      headers: {
        get(name: string) {
          return next.headers?.[name.toLowerCase()] ?? null;
        },
      },
    };
  };

  return Object.assign(stub, { calls });
}

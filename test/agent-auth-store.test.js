import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentAuthStore,
  RateLimitExceededError,
  ScopeDeniedError,
  UnauthorizedError
} from "../src/agent-auth-store.ts";

test("creates an agent API key with normalized identity, scopes, and rate limits", () => {
  const now = new Date("2026-05-01T04:00:00Z");
  const authStore = new AgentAuthStore({ now: () => now });

  const response = authStore.createKey(
    {
      agent: {
        id: "agt_codex_cto",
        displayName: "Codex CTO",
        role: "cto",
        externalIdentities: [
          {
            provider: "github",
            subject: "agentrail-codex-cto"
          }
        ]
      },
      scopes: ["ci:read", "tasks:read", "ci:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 120
      },
      expiresAt: "2026-06-01T00:00:00Z"
    },
    "agent-key-AGEA-7-v1"
  );

  assert.match(response.data.id, /^akey_/);
  assert.match(response.data.apiKey, /^ar_live_/);
  assert.equal(response.data.agent.id, "agt_codex_cto");
  assert.equal(response.data.agent.displayName, "Codex CTO");
  assert.deepEqual(response.data.agent.externalIdentities, [
    {
      provider: "github",
      subject: "agentrail-codex-cto"
    }
  ]);
  assert.deepEqual(response.data.scopes, ["ci:read", "tasks:read"]);
  assert.deepEqual(response.data.rateLimit, {
    windowSeconds: 60,
    maxRequests: 120
  });
  assert.equal(response.data.status, "active");
  assert.equal(response.data.createdAt, "2026-05-01T04:00:00.000Z");
  assert.equal(response.data.expiresAt, "2026-06-01T00:00:00Z");
  assert.deepEqual(response.data.availableActions, ["rotate", "view_usage"]);
  assert.deepEqual(response.availableActions, ["rotate", "view_usage"]);

  const replay = authStore.createKey(
    {
      agent: {
        id: "agt_codex_cto",
        displayName: "Codex CTO",
        role: "cto",
        externalIdentities: [
          {
            provider: "github",
            subject: "agentrail-codex-cto"
          }
        ]
      },
      scopes: ["tasks:read", "ci:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 120
      },
      expiresAt: "2026-06-01T00:00:00Z"
    },
    "agent-key-AGEA-7-v1"
  );

  assert.deepEqual(replay, response);
});

test("authenticates keys, enforces scopes, and tracks per-operation usage", () => {
  let currentNow = new Date("2026-05-01T04:10:00Z");
  const authStore = new AgentAuthStore({ now: () => currentNow });
  const { data } = authStore.createKey(
    {
      agent: {
        id: "agt_founder",
        displayName: "Founding Engineer",
        role: "founding_engineer"
      },
      scopes: ["tasks:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 2
      }
    },
    "agent-key-AGEA-7-scope-v1"
  );

  const principal = authStore.authenticate({
    authorizationHeader: `Bearer ${data.apiKey}`,
    requiredScope: "tasks:read",
    operation: "list_my_tasks"
  });

  assert.equal(principal.keyId, data.id);
  assert.equal(principal.agent.id, "agt_founder");
  assert.deepEqual(principal.scopes, ["tasks:read"]);

  assert.throws(
    () =>
      authStore.authenticate({
        authorizationHeader: `Bearer ${data.apiKey}`,
        requiredScope: "webhooks:write",
        operation: "create_webhook_subscription"
      }),
    ScopeDeniedError
  );

  authStore.authenticate({
    authorizationHeader: `Bearer ${data.apiKey}`,
    requiredScope: "tasks:read",
    operation: "get_task"
  });

  assert.throws(
    () =>
      authStore.authenticate({
        authorizationHeader: `Bearer ${data.apiKey}`,
        requiredScope: "tasks:read",
        operation: "get_task"
      }),
    RateLimitExceededError
  );

  currentNow = new Date("2026-05-01T04:11:01Z");
  authStore.authenticate({
    authorizationHeader: `Bearer ${data.apiKey}`,
    requiredScope: "tasks:read",
    operation: "get_task"
  });

  const usage = authStore.getUsage(data.id);
  assert.equal(usage.data.keyId, data.id);
  assert.equal(usage.data.agent.id, "agt_founder");
  assert.equal(usage.data.totals.accepted, 3);
  assert.equal(usage.data.totals.denied, 2);
  assert.deepEqual(usage.data.byScope, [
    {
      scope: "tasks:read",
      count: 3
    }
  ]);
  assert.deepEqual(usage.data.byOperation, [
    {
      operation: "get_task",
      count: 2
    },
    {
      operation: "list_my_tasks",
      count: 1
    }
  ]);
});

test("rotates an agent key without changing identity or scopes", () => {
  const authStore = new AgentAuthStore({
    now: () => new Date("2026-05-01T04:20:00Z")
  });
  const created = authStore.createKey(
    {
      agent: {
        id: "agt_platform_ci",
        displayName: "Platform CI",
        role: "platform_ci"
      },
      scopes: ["ci:read", "events:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 300
      }
    },
    "agent-key-AGEA-7-rotate-v1"
  );

  const rotated = authStore.rotateKey(created.data.id, {}, "agent-key-AGEA-7-rotate-v2");

  assert.match(rotated.data.id, /^akey_/);
  assert.notEqual(rotated.data.id, created.data.id);
  assert.match(rotated.data.apiKey, /^ar_live_/);
  assert.notEqual(rotated.data.apiKey, created.data.apiKey);
  assert.equal(rotated.data.rotatedFromKeyId, created.data.id);
  assert.equal(rotated.data.agent.id, "agt_platform_ci");
  assert.deepEqual(rotated.data.scopes, ["ci:read", "events:read"]);
  assert.deepEqual(rotated.data.rateLimit, {
    windowSeconds: 60,
    maxRequests: 300
  });

  assert.throws(
    () =>
      authStore.authenticate({
        authorizationHeader: `Bearer ${created.data.apiKey}`,
        requiredScope: "ci:read",
        operation: "get_ci_status"
      }),
    UnauthorizedError
  );

  const principal = authStore.authenticate({
    authorizationHeader: `Bearer ${rotated.data.apiKey}`,
    requiredScope: "ci:read",
    operation: "get_ci_status"
  });
  assert.equal(principal.keyId, rotated.data.id);
});

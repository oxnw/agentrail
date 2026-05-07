import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { AgentAuthStore } from "../src/agent-auth-store.ts";

test("AgentAuthStore persists keys and rotates with updated scopes and metadata", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-auth-store-"));
  const storagePath = path.join(tempDir, "auth-store.json");

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const authStore = new AgentAuthStore({
    now: () => new Date("2026-05-06T12:00:00Z"),
    storagePath,
  });

  const created = authStore.createKey({
    agent: {
      id: "agt_example",
      displayName: "Example",
      role: "coding_agent",
      externalIdentities: [{ provider: "github", subject: "octocat" }],
    },
    scopes: ["tasks:read", "tasks:write"],
  }, "create-agent-example-v1");

  const reloaded = new AgentAuthStore({
    now: () => new Date("2026-05-06T12:05:00Z"),
    storagePath,
  });

  const rotated = reloaded.rotateKey(created.data.id, {
    agent: {
      displayName: "Updated Example",
      role: "reviewer",
      externalIdentities: [{ provider: "github", subject: "updated-octocat" }],
    },
    scopes: ["tasks:read", "ship:write"],
  }, "rotate-agent-example-v1");

  const rotatedUsage = reloaded.getUsage(rotated.data.id);
  const oldUsage = reloaded.getUsage(created.data.id);
  const stored = JSON.parse(await readFile(storagePath, "utf8"));

  assert.ok(rotatedUsage.data, "rotatedUsage should have data");
  assert.ok(oldUsage.data, "oldUsage should have data");
  assert.ok(stored && typeof stored === "object", "persisted auth store should be a JSON object");
  assert.ok(Array.isArray(stored.keys), "persisted auth store should include a keys array");
  assert.deepEqual(rotatedUsage.data.scopes, ["ship:write", "tasks:read"]);
  assert.equal(rotatedUsage.data.agent.displayName, "Updated Example");
  assert.equal(rotatedUsage.data.agent.role, "reviewer");
  assert.deepEqual(rotatedUsage.data.agent.externalIdentities, [{ provider: "github", subject: "updated-octocat" }]);
  assert.equal(oldUsage.data.status, "rotated");
  assert.equal(stored.keys.length, 2);
});

test("AgentAuthStore persists usage counters and rate window state across restart", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-auth-usage-"));
  const storagePath = path.join(tempDir, "auth-store.json");
  let now = new Date("2026-05-06T12:00:00Z");

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const authStore = new AgentAuthStore({
    now: () => now,
    storagePath,
  });

  const created = authStore.createKey({
    agent: {
      id: "agt_usage",
      displayName: "Usage Example",
      role: "coding_agent",
    },
    scopes: ["tasks:read"],
    rateLimit: {
      windowSeconds: 60,
      maxRequests: 5,
    },
  }, "create-usage-example-v1");

  const authResult = authStore.authenticate({
    authorizationHeader: `Bearer ${created.data.apiKey}`,
    requiredScope: "tasks:read",
    operation: "list_my_tasks",
  });
  assert.deepEqual(authResult, {
    keyId: created.data.id,
    agent: {
      id: "agt_usage",
      displayName: "Usage Example",
      role: "coding_agent",
      externalIdentities: [],
    },
    scopes: ["tasks:read"],
  });

  now = new Date("2026-05-06T12:00:10Z");

  const reloaded = new AgentAuthStore({
    now: () => now,
    storagePath,
  });
  const usage = reloaded.getUsage(created.data.id);

  assert.equal(usage.data.lastUsedAt, "2026-05-06T12:00:00.000Z");
  assert.deepEqual(usage.data.totals, { accepted: 1, denied: 0 });
  assert.deepEqual(usage.data.byScope, [{ scope: "tasks:read", count: 1 }]);
  assert.deepEqual(usage.data.byOperation, [{ operation: "list_my_tasks", count: 1 }]);
  assert.equal(usage.data.rateLimit.currentWindow.used, 1);
  assert.equal(usage.data.rateLimit.currentWindow.remaining, 4);
});

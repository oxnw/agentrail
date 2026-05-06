import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { AgentProfileStore } from "../src/agent-profile-store.ts";

const now = () => new Date("2026-05-05T12:00:00Z");

function tmpPath() {
  return path.join(os.tmpdir(), `agent-profile-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makePayload(overrides = {}) {
  return {
    displayName: "CTO",
    role: "cto",
    status: "active" as const,
    capabilityTags: ["api-design"],
    ownershipTags: ["control-plane"],
    repoAllowlist: ["oxnw/agentrail"],
    providerIdentityMappings: [{ provider: "github" as const, subject: "cto-github" }],
    maxConcurrentTasks: 5,
    sourceRef: "AGEA-99",
    changeReason: "seed",
    ...overrides,
  };
}

test("AgentProfileStore persists profiles to file and loads on restart", async (t) => {
  const storagePath = tmpPath();
  const store1 = new AgentProfileStore({ now, storagePath });
  store1.replaceAgentProfile("agt_cto", makePayload(), "agt_operator", "idemp-1");

  const store2 = new AgentProfileStore({ now, storagePath });
  const profile = store2.getAgentProfile("agt_cto");
  assert.ok(profile);
  assert.equal(profile?.displayName, "CTO");
  assert.equal(profile?.source, "operator_admin");
  assert.equal(profile?.updatedBy, "agt_operator");

  fs.unlinkSync(storagePath);
});

test("AgentProfileStore returns null for unknown agent", () => {
  const store = new AgentProfileStore({ now });
  assert.equal(store.getAgentProfile("agt_unknown"), null);
});

test("AgentProfileStore supports idempotency with same payload", () => {
  const store = new AgentProfileStore({ now });
  const p1 = store.replaceAgentProfile("agt_cto", makePayload(), "agt_operator", "idemp-same");
  const p2 = store.replaceAgentProfile("agt_cto", makePayload(), "agt_operator", "idemp-same");
  assert.deepEqual(p1, p2);
});

test("AgentProfileStore rejects idempotency key with different payload", () => {
  const store = new AgentProfileStore({ now });
  store.replaceAgentProfile("agt_cto", makePayload(), "agt_operator", "idemp-diff");
  assert.throws(
    () => store.replaceAgentProfile("agt_cto", makePayload({ displayName: "CTO2" }), "agt_operator", "idemp-diff"),
    (e: any) => e.statusCode === 409 && e.code === "conflict"
  );
});

test("AgentProfileStore validates agentId prefix", () => {
  const store = new AgentProfileStore({ now });
  assert.throws(
    () => store.replaceAgentProfile("bad_id", makePayload(), "agt_operator"),
    (e: any) => e.statusCode === 400
  );
});

test("AgentProfileStore validates payload is an object", () => {
  const store = new AgentProfileStore({ now });
  assert.throws(
    () => store.replaceAgentProfile("agt_cto", null as any, "agt_operator"),
    (e: any) => e.statusCode === 400
  );
});

test("AgentProfileStore replaces existing profile and updates metadata", () => {
  const store = new AgentProfileStore({ now });
  const p1 = store.replaceAgentProfile("agt_cto", makePayload(), "agt_operator");
  const p2 = store.replaceAgentProfile("agt_cto", makePayload({ displayName: "CTO2", changeReason: "rename" }), "agt_other");
  assert.equal(p2.displayName, "CTO2");
  assert.equal(p2.updatedBy, "agt_other");
  assert.equal(p2.source, "operator_admin");
});

test("AgentProfileStore persists through multiple mutations", () => {
  const storagePath = tmpPath();
  const store1 = new AgentProfileStore({ now, storagePath });
  store1.replaceAgentProfile("agt_a", makePayload({ displayName: "A" }), "op", "i1");
  store1.replaceAgentProfile("agt_b", makePayload({ displayName: "B" }), "op", "i2");

  const store2 = new AgentProfileStore({ now, storagePath });
  assert.equal(store2.getAgentProfile("agt_a")?.displayName, "A");
  assert.equal(store2.getAgentProfile("agt_b")?.displayName, "B");

  fs.unlinkSync(storagePath);
});

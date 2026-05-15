import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoutingClassifierPrompt,
  parseRoutingClassifierOutput,
} from "../src/routing-classifier.ts";
import type { ProviderIssueSnapshot } from "../src/intake-routing-control-plane.ts";

function makeSnapshot(overrides: Partial<ProviderIssueSnapshot> = {}): ProviderIssueSnapshot {
  return {
    provider: "github",
    providerIssueId: "github:oxnw/agentrail:issues/12",
    sourceVersion: "delivery-1",
    repository: { provider: "github", owner: "oxnw", name: "agentrail", defaultBranch: "main" },
    title: "Fix duplicate login session",
    bodyDigest: "sha256:body",
    bodyPreview: "Clicking login twice creates two sessions.",
    labels: ["bug", "auth"],
    project: "oxnw/agentrail",
    issueType: "bug",
    priority: "medium",
    ownershipTags: [],
    capabilityTags: [],
    links: { providerIssue: "https://github.com/oxnw/agentrail/issues/12" },
    ...overrides,
  };
}

test("buildRoutingClassifierPrompt includes issue context and capability inventory", () => {
  const prompt = buildRoutingClassifierPrompt({
    snapshot: makeSnapshot(),
    candidates: [
      {
        agentId: "agt_auth",
        displayName: "Auth Agent",
        capabilityTags: ["auth", "typescript"],
        ownershipTags: ["login"],
        repoAllowlist: ["oxnw/agentrail"],
        activeTaskCount: 0,
        maxConcurrentTasks: 1,
      },
    ],
  });

  assert.match(prompt, /Fix duplicate login session/);
  assert.match(prompt, /Clicking login twice/);
  assert.match(prompt, /auth/);
  assert.match(prompt, /Return only JSON/);
});

test("parseRoutingClassifierOutput accepts strict JSON result", () => {
  const result = parseRoutingClassifierOutput(JSON.stringify({
    taskType: "bugfix",
    requiredCapabilities: ["auth", "typescript"],
    optionalCapabilities: ["tests"],
    ownershipHints: ["login"],
    missingInfo: [],
    unmatchedCapabilities: [],
    confidence: 0.91,
    evidence: ["Label auth", "Body mentions login sessions"],
  }), ["auth", "typescript", "tests"]);

  assert.deepEqual(result.requiredCapabilities, ["auth", "typescript"]);
  assert.deepEqual(result.optionalCapabilities, ["tests"]);
  assert.equal(result.confidence, 0.91);
});

test("parseRoutingClassifierOutput accepts a single fenced JSON block", () => {
  const result = parseRoutingClassifierOutput(`\`\`\`json
{"taskType":"bugfix","requiredCapabilities":["auth"],"optionalCapabilities":[],"ownershipHints":[],"missingInfo":[],"unmatchedCapabilities":[],"confidence":0.8,"evidence":[]}
\`\`\``, ["auth"]);

  assert.deepEqual(result.requiredCapabilities, ["auth"]);
  assert.equal(result.confidence, 0.8);
});

test("parseRoutingClassifierOutput rejects malformed and unknown capability output", () => {
  assert.throws(() => parseRoutingClassifierOutput("{ nope", ["auth"]), /valid JSON/);
  assert.throws(() => parseRoutingClassifierOutput(JSON.stringify({
    taskType: "bugfix",
    requiredCapabilities: ["payments"],
    optionalCapabilities: [],
    ownershipHints: [],
    missingInfo: [],
    unmatchedCapabilities: [],
    confidence: 0.9,
    evidence: ["unsupported"],
  }), ["auth"]), /unknown required capability/);
});

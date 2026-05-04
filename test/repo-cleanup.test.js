import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";

const removedInternalArtifacts = [
  "verify-browser.mjs",
  "verify-waitlist.mjs",
  "verify-waitlist-api.mjs",
  "verify-landing-claims.mjs",
  "benchmarks/landing-page-claims/benchmark-github-review-feedback.mjs",
  "benchmarks/landing-page-claims/results.json",
  "scripts/phase1-dogfood.mjs",
  "scripts/phase2-dogfood.mjs",
  "scripts/phase3-dogfood.mjs",
  "scripts/phase4-dogfood.mjs",
  "scripts/live-e2e.mjs",
  "scripts/test-github-submit.sh",
  "waitlist-server.mjs",
  "openapi/waitlist.yaml",
  "index-light.html",
  "original-index-light.html",
  "docs/dogfood-setup.md",
  "docs/cloud.md",
  "ROADMAP.md",
  "docs/adr/0001-task-lifecycle-api.md",
  "docs/adr/0002-sdk-generation-and-contract-gates.md",
  "docs/adr/0002-task-lifecycle-push-delivery.md",
  "docs/adr/0003-task-lifecycle-sse-replay-buffer.md",
  "docs/adr/0003-task-webhook-worker-implementation.md",
  "docs/adr/0004-github-actions-ci-status-adapter.md",
  "docs/adr/0005-agent-authentication-model.md",
  "docs/adr/0006-waitlist-workflow.md",
  "docs/adr/0007-circleci-ci-adapter.md",
  "docs/superpowers/plans/2026-05-04-github-submit-integration-test.md"
];

const keptPublicArtifacts = [
  "landing/index-light.html",
  "scripts/agentrail-e2e-demo.mjs",
  "docs/demo/agentrail-e2e-demo.md",
  "docs/api/task-lifecycle.openapi.yaml"
];

for (const relativePath of removedInternalArtifacts) {
  test(`public repo excludes ${relativePath}`, async () => {
    await assert.rejects(
      access(relativePath, constants.F_OK),
      (error) => error?.code === "ENOENT"
    );
  });
}

for (const relativePath of keptPublicArtifacts) {
  test(`public repo keeps ${relativePath}`, async () => {
    await access(relativePath, constants.F_OK);
  });
}

test(".gitignore blocks local env files but keeps the public template", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

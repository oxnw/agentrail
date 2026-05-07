import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { resolveLiveConfig } from "../scripts/agentrail-sandbox-smoke.mjs";

async function withManifest(contents, fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-sandbox-manifest-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(contents, null, 2));
  try {
    await fn(manifestPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("resolveLiveConfig loads seeded scenario values from manifest", async () => {
  await withManifest({
    scenarios: [
      {
        id: "golden-open",
        kind: "seeded",
        baseBranch: "main",
        allowShip: false,
        live: {
          owner: "oxnw",
          repo: "agentrail-e2e-sandbox",
          issueNumber: 11,
          pullNumber: 12,
          headBranch: "scenario/golden-open",
          expectedHeadSha: "abc123"
        }
      }
    ]
  }, async (manifestPath) => {
    const config = await resolveLiveConfig({
      env: {
        GITHUB_TOKEN: "ghs_test",
        AGENTRAIL_SANDBOX_SCENARIO_ID: "golden-open",
        AGENTRAIL_SANDBOX_MANIFEST_PATH: manifestPath
      }
    });

    assert.equal(config.owner, "oxnw");
    assert.equal(config.repo, "agentrail-e2e-sandbox");
    assert.equal(config.issueNumber, 11);
    assert.equal(config.pullNumber, 12);
    assert.equal(config.headBranch, "scenario/golden-open");
    assert.equal(config.baseBranch, "main");
    assert.equal(config.allowShip, false);
    assert.equal(config.expectedHeadSha, "abc123");
  });
});

test("resolveLiveConfig lets explicit env vars override manifest values", async () => {
  await withManifest({
    scenarios: [
      {
        id: "golden-open",
        kind: "seeded",
        baseBranch: "main",
        allowShip: false,
        live: {
          owner: "oxnw",
          repo: "agentrail-e2e-sandbox",
          issueNumber: 11,
          pullNumber: 12,
          headBranch: "scenario/golden-open"
        }
      }
    ]
  }, async (manifestPath) => {
    const config = await resolveLiveConfig({
      env: {
        AGENTRAIL_SANDBOX_SCENARIO_ID: "golden-open",
        AGENTRAIL_SANDBOX_MANIFEST_PATH: manifestPath,
        AGENTRAIL_SANDBOX_ISSUE_NUMBER: "90",
        AGENTRAIL_SANDBOX_PULL_NUMBER: "91",
        AGENTRAIL_SANDBOX_HEAD_BRANCH: "scratch/override",
        AGENTRAIL_SANDBOX_ALLOW_SHIP: "true"
      }
    });

    assert.equal(config.issueNumber, 90);
    assert.equal(config.pullNumber, 91);
    assert.equal(config.headBranch, "scratch/override");
    assert.equal(config.allowShip, true);
  });
});

test("resolveLiveConfig rejects scratch scenarios without runtime issue and pull inputs", async () => {
  await withManifest({
    scenarios: [
      {
        id: "scratch-live-cycle",
        kind: "scratch",
        baseBranch: "integration/live",
        allowShip: true,
        live: {
          owner: "oxnw",
          repo: "agentrail-e2e-sandbox"
        }
      }
    ]
  }, async (manifestPath) => {
    await assert.rejects(
      () => resolveLiveConfig({
        env: {
          AGENTRAIL_SANDBOX_SCENARIO_ID: "scratch-live-cycle",
          AGENTRAIL_SANDBOX_MANIFEST_PATH: manifestPath
        }
      }),
      /AGENTRAIL_SANDBOX_ISSUE_NUMBER/
    );
  });
});

test("resolveLiveConfig requires manifest path when scenario id is set", async () => {
  await assert.rejects(
    () => resolveLiveConfig({
      env: {
        AGENTRAIL_SANDBOX_SCENARIO_ID: "golden-open"
      }
    }),
    /AGENTRAIL_SANDBOX_MANIFEST_PATH/
  );
});

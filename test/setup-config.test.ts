import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInitCommand,
  createSetupConfig,
  validateSafeDefaults,
  type DetectedRepoContext,
} from "../src/cli/setup-config.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "/tmp/agentrail",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("createSetupConfig derives server defaults from repo detection", () => {
  const config = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: true,
  });

  assert.equal(config.mode, "server");
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, 3000);
  assert.equal(config.server.baseUrl, "http://127.0.0.1:3000");
  assert.equal(config.persistence.kind, "file");
  assert.equal(config.persistence.engine, "file");
  assert.equal(config.persistence.authStorePath, "stores/agent-auth.json");
  assert.equal(config.providers.github.mode, "real");
  assert.equal(config.providers.circleci.mode, "real");
  assert.deepEqual(config.repos.map((repo) => repo.slug), ["oxnw/agentrail"]);
  assert.equal(config.repos[0].defaultBranch, "main");
  assert.equal(config.exports.markdown.enabled, false);
});

test("--yes safety validation rejects non-local or live defaults", () => {
  const safeConfig = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
  });

  assert.deepEqual(validateSafeDefaults(safeConfig, detectedRepo), {
    ok: true,
    reasons: [],
  });

  const unsafeConfig = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo: {
      ...detectedRepo,
      gitIgnoreHasAgentrail: false,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    mode: "server",
    host: "0.0.0.0",
    baseUrl: "http://0.0.0.0:3000",
  });

  const validation = validateSafeDefaults(unsafeConfig, {
    ...detectedRepo,
    gitIgnoreHasAgentrail: false,
  });

  assert.equal(validation.ok, false);
  assert.match(validation.reasons.join("\n"), /local bind/i);
  assert.match(validation.reasons.join("\n"), /live GitHub or CircleCI providers/i);
});

test("buildInitCommand renders an equivalent non-interactive command", () => {
  const config = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: false,
    markdownExport: true,
  });

  const command = buildInitCommand(config);

  assert.match(command, /^agentrail init /);
  assert.match(command, /--mode server/);
  assert.match(command, /--base-url http:\/\/127\.0\.0\.1:3000/);
  assert.match(command, /--repo '\/tmp\/agentrail'/);
  assert.match(command, /--repo-allowlist oxnw\/agentrail/);
  assert.match(command, /--markdown-export/);
  assert.doesNotMatch(command, /--provider-mode/);
});

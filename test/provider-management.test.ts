import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import { createSetupConfig, type DetectedRepoContext } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "/tmp/agentrail-provider-test",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("provider connect github writes provider.env and updates config", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  process.env.AGENTRAIL_HOME = homePath;
  process.env.GITHUB_TOKEN = "ghp_test_provider_token";

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
  });

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      ...detectedRepo,
      repoPath: repoRoot,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
  });
  await writeSetupFiles({ homePath, config });

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Connected GitHub using GITHUB_TOKEN/);

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_test_provider_token"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.github.mode, "real");
  assert.equal(nextConfig.providers.github.tokenEnv, "GITHUB_TOKEN");
});

test("provider test github fails clearly when not connected", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
  });

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      ...detectedRepo,
      repoPath: repoRoot,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
  });
  await writeSetupFiles({ homePath, config });

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /GitHub is not connected yet/);
});

function createMemoryWriter() {
  let buffer = "";
  return {
    write(chunk: string | Uint8Array) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    toString() {
      return buffer;
    },
  };
}

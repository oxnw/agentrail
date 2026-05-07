import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import { createSetupConfig, type DetectedRepoContext } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("provider connect github writes provider.env and updates config", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
  });

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
  const { repoRoot } = await setupProviderTest(t);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1, stderr.toString());
  assert.match(stderr.toString(), /GitHub is not connected yet/);
});

async function setupProviderTest(
  t: { after(fn: () => unknown): void },
  env: Record<string, string> = {},
): Promise<{ repoRoot: string; homePath: string }> {
  let repoRoot: string | undefined;
  let homePath: string | undefined;
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousEnv = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );

  t.after(async () => {
    try {
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true });
      }
      if (homePath) {
        await rm(homePath, { recursive: true, force: true });
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
      else process.env.AGENTRAIL_HOME = previousHome;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-repo-"));
  homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-home-"));
  process.env.AGENTRAIL_HOME = homePath;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

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
  return { repoRoot, homePath };
}

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

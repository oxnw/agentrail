import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { loadEnvFile } from "../src/env-file.ts";

test("loadEnvFile can overwrite existing process env values when requested", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-env-file-"));
  const envPath = path.join(tempDir, "provider.env");
  const previousToken = process.env.GITHUB_TOKEN;

  t.after(async () => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(envPath, 'GITHUB_TOKEN="ghp_from_provider_env"\n', "utf8");

  process.env.GITHUB_TOKEN = "ghp_from_repo_env";
  loadEnvFile(envPath);
  assert.equal(process.env.GITHUB_TOKEN, "ghp_from_repo_env");

  loadEnvFile(envPath, { overwrite: true });
  assert.equal(process.env.GITHUB_TOKEN, "ghp_from_provider_env");
});

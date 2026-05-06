import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createSetupDoctorHarness,
  writeDoctorRepo,
} from "./helpers/setup-doctor-fixture.ts";

test("agentrail doctor fails when setup state exists but no assigned onboarding task is visible", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-fail-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const harness = await createSetupDoctorHarness();

  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  t.after(async () => {
    process.env.AGENTRAIL_SETUP_API_KEY = previousSetupApiKey;
    await rm(repoRoot, { recursive: true, force: true });
    await new Promise((resolve) => harness.server.close(resolve));
  });

  await writeDoctorRepo({
    repoRoot,
    baseUrl: harness.baseUrl,
    agentApiKey: harness.agentApiKey,
    agentId: harness.agentId,
    repoAllowlist: harness.repoAllowlist,
  });

  const exitCode = await runCli(["doctor"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /assigned_task_visibility/i);
  assert.match(stderr.toString(), /operator\/setup\/verification-task/i);
  assert.match(stderr.toString(), /setup-verification:agt_setup:v1/i);
  assert.equal(stdout.toString(), "");
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

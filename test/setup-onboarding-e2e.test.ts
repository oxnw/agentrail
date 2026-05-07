import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createSetupDoctorHarness,
  seedSetupVerificationTask,
  type SetupDoctorHarness,
  writeDoctorRepo,
} from "./helpers/setup-doctor-fixture.ts";

test("agentrail doctor passes after the full local onboarding smoke seeds profile, routing, and setup task state", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-onboarding-e2e-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  let harness: SetupDoctorHarness | null = null;

  t.after(async () => {
    try {
      await rm(repoRoot, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
      else process.env.AGENTRAIL_HOME = previousHome;
      await rm(homePath, { recursive: true, force: true });
    } finally {
      restoreSetupApiKey(previousSetupApiKey);
      await harness?.close();
    }
  });
  process.env.AGENTRAIL_HOME = homePath;

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  await writeDoctorRepo({
    repoRoot,
    homePath,
    baseUrl: harness.baseUrl,
    agentApiKey: harness.agentApiKey,
    agentId: harness.agentId,
    repoAllowlist: harness.repoAllowlist,
  });
  await seedSetupVerificationTask({
    baseUrl: harness.baseUrl,
    operatorApiKey: harness.operatorApiKey,
    agentId: harness.agentId,
  });

  const exitCode = await runCli(["doctor"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /AgentRail doctor passed/i);
  assert.match(stdout.toString(), /LOCAL-SETUP-AGT-SETUP/i);
  assert.match(stdout.toString(), /oxnw\/agentrail/i);
  assert.equal(stderr.toString(), "");
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

function restoreSetupApiKey(previousSetupApiKey: string | undefined): void {
  if (previousSetupApiKey === undefined) {
    delete process.env.AGENTRAIL_SETUP_API_KEY;
    return;
  }
  process.env.AGENTRAIL_SETUP_API_KEY = previousSetupApiKey;
}

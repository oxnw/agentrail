import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createSetupDoctorHarness,
  type SetupDoctorHarness,
  writeDoctorRepo,
} from "./helpers/setup-doctor-fixture.ts";

test("agentrail doctor fails when setup state exists but no assigned onboarding task is visible", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-fail-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  let harness: SetupDoctorHarness | null = null;

  t.after(async () => {
    restoreSetupApiKey(previousSetupApiKey);
    await rm(repoRoot, { recursive: true, force: true });
    await harness?.close();
  });

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

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

test("agentrail doctor does not pass on an unrelated assigned in-progress task", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-unrelated-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  let harness: SetupDoctorHarness | null = null;

  t.after(async () => {
    restoreSetupApiKey(previousSetupApiKey);
    await rm(repoRoot, { recursive: true, force: true });
    await harness?.close();
  });

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  harness.taskQueue.createTask({
    identifier: "github:oxnw/agentrail:issues/unrelated",
    title: "Unrelated work",
    description: "This task proves doctor must find the setup verification task specifically.",
    status: "in_progress",
    priority: "medium",
    assignee: { id: harness.agentId, name: "Setup Agent" },
    assigneeAgentId: harness.agentId,
    acceptanceCriteria: [],
    links: { issue: "https://github.com/oxnw/agentrail/issues/unrelated" },
    context: { project: "oxnw/agentrail", goal: "Unrelated work" },
    availableActions: ["submit"],
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
  assert.match(stderr.toString(), /LOCAL-SETUP-AGT-SETUP/i);
  assert.match(stderr.toString(), /github:oxnw\/agentrail:issues\/unrelated/i);
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

function restoreSetupApiKey(previousSetupApiKey: string | undefined): void {
  if (previousSetupApiKey === undefined) {
    delete process.env.AGENTRAIL_SETUP_API_KEY;
    return;
  }
  process.env.AGENTRAIL_SETUP_API_KEY = previousSetupApiKey;
}

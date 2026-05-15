import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createSetupDoctorHarness,
  seedSetupVerificationTask,
  type SetupDoctorHarness,
  writeDoctorRepo,
} from "./helpers/setup-doctor-fixture.ts";
import { currentAgentEnvPathForHome } from "../src/cli/agentrail-home.ts";
import { createMemoryWriter } from "./helpers/memory-writer.ts";

test("agentrail doctor fails when setup state exists but no assigned onboarding task is visible", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-fail-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  let harness: SetupDoctorHarness | null = null;
  t.after(createCleanup({
    previousSetupApiKey,
    previousHome,
    repoRoot,
    homePath,
    getHarness: () => harness,
  }));
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
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  let harness: SetupDoctorHarness | null = null;
  t.after(createCleanup({
    previousSetupApiKey,
    previousHome,
    repoRoot,
    homePath,
    getHarness: () => harness,
  }));
  process.env.AGENTRAIL_HOME = homePath;

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
    homePath,
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

test("agentrail doctor honors an explicit --env-file over the shared current-agent alias", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-explicit-env-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  let harness: SetupDoctorHarness | null = null;
  t.after(createCleanup({
    previousSetupApiKey,
    previousHome,
    repoRoot,
    homePath,
    getHarness: () => harness,
  }));
  process.env.AGENTRAIL_HOME = homePath;

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  await seedSetupVerificationTask({
    baseUrl: harness.baseUrl,
    operatorApiKey: harness.operatorApiKey,
    agentId: harness.agentId,
  });

  await writeDoctorRepo({
    repoRoot,
    homePath,
    baseUrl: harness.baseUrl,
    agentApiKey: harness.agentApiKey,
    agentId: harness.agentId,
    repoAllowlist: harness.repoAllowlist,
  });

  await writeFile(
    currentAgentEnvPathForHome(homePath),
    [
      `AGENTRAIL_BASE_URL=${harness.baseUrl}`,
      "AGENTRAIL_API_KEY=ar_live_wrong",
      "AGENTRAIL_AGENT_ID=agt_wrong",
      "AGENTRAIL_AGENT_RUNNER=codex",
      "AGENTRAIL_REPO_ALLOWLIST=oxnw/wrong",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const explicitEnvPath = path.join(repoRoot, "tmp", "doctor-explicit.env");
  await mkdir(path.dirname(explicitEnvPath), { recursive: true });
  await writeFile(
    explicitEnvPath,
    [
      `AGENTRAIL_BASE_URL=${harness.baseUrl}`,
      `AGENTRAIL_API_KEY=${harness.agentApiKey}`,
      `AGENTRAIL_AGENT_ID=${harness.agentId}`,
      "AGENTRAIL_AGENT_RUNNER=codex",
      `AGENTRAIL_REPO_ALLOWLIST=${harness.repoAllowlist.join(",")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const exitCode = await runCli(["doctor", "--env-file", path.relative(repoRoot, explicitEnvPath)], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /AgentRail doctor passed/i);
  assert.equal(stderr.toString(), "");
});

test("agentrail doctor verifies AI routing can launch the configured local runner", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-ai-route-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousPath = process.env.PATH;
  let harness: SetupDoctorHarness | null = null;
  const cleanup = createCleanup({
    previousSetupApiKey,
    previousHome,
    repoRoot,
    homePath,
    getHarness: () => harness,
  });
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await cleanup();
  });
  process.env.AGENTRAIL_HOME = homePath;

  const binDir = path.join(repoRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeCodex = path.join(binDir, "codex");
  await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
  await chmod(fakeCodex, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  await seedSetupVerificationTask({
    baseUrl: harness.baseUrl,
    operatorApiKey: harness.operatorApiKey,
    agentId: harness.agentId,
  });

  await writeDoctorRepo({
    repoRoot,
    homePath,
    baseUrl: harness.baseUrl,
    agentApiKey: harness.agentApiKey,
    agentId: harness.agentId,
    repoAllowlist: harness.repoAllowlist,
    routingMode: "ai_assist",
    routingClassifierRunner: "codex",
    routingClassifierModel: "gpt-test",
  });

  const exitCode = await runCli(["doctor"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /PASS ai_routing/i);
  assert.match(stdout.toString(), /gpt-test/i);
  assert.equal(stderr.toString(), "");
});

test("agentrail doctor fails AI routing when no local executable mapping exists", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-doctor-ai-route-fail-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousSetupApiKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousHome = process.env.AGENTRAIL_HOME;
  let harness: SetupDoctorHarness | null = null;
  t.after(createCleanup({
    previousSetupApiKey,
    previousHome,
    repoRoot,
    homePath,
    getHarness: () => harness,
  }));
  process.env.AGENTRAIL_HOME = homePath;

  harness = await createSetupDoctorHarness();
  process.env.AGENTRAIL_SETUP_API_KEY = harness.operatorApiKey;

  await seedSetupVerificationTask({
    baseUrl: harness.baseUrl,
    operatorApiKey: harness.operatorApiKey,
    agentId: harness.agentId,
  });

  await writeDoctorRepo({
    repoRoot,
    homePath,
    baseUrl: harness.baseUrl,
    agentApiKey: harness.agentApiKey,
    agentId: harness.agentId,
    repoAllowlist: harness.repoAllowlist,
    routingMode: "ai_assist",
    routingClassifierRunner: "custom",
  });

  const exitCode = await runCli(["doctor"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /FAIL ai_routing/i);
  assert.match(stderr.toString(), /custom/i);
  assert.equal(stdout.toString(), "");
});

function restoreSetupApiKey(previousSetupApiKey: string | undefined): void {
  if (previousSetupApiKey === undefined) {
    delete process.env.AGENTRAIL_SETUP_API_KEY;
    return;
  }
  process.env.AGENTRAIL_SETUP_API_KEY = previousSetupApiKey;
}

function createCleanup({
  previousSetupApiKey,
  previousHome,
  repoRoot,
  homePath,
  getHarness,
}: {
  previousSetupApiKey: string | undefined;
  previousHome: string | undefined;
  repoRoot: string;
  homePath: string;
  getHarness: () => SetupDoctorHarness | null;
}) {
  return async () => {
    try {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(homePath, { recursive: true, force: true });
    } finally {
      restoreSetupApiKey(previousSetupApiKey);
      if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
      else process.env.AGENTRAIL_HOME = previousHome;
      await getHarness()?.close();
    }
  };
}

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_RUNNER_EXECUTION_POLICY,
  buildRunnerPolicyEnv,
  compileRunnerExecutionPlan,
  hardenProtectedInstructionFiles,
  normalizeRunnerExecutionPolicy,
  validateRunnerPolicyFilesystemPostRun,
  validateRunnerPolicyFilesystemPreflight,
  validateRunnerPolicyPlan,
  writeRunnerPolicyGeneratedFiles,
} from "../src/runner-execution-policy.ts";

const basePlanInput = {
  model: null,
  worktreePath: "/tmp/worktree",
  runDir: "/tmp/run",
  recipePath: "/tmp/run/agent-recipes.md",
  prompt: "do work",
  baseEnv: {
    PATH: "/usr/bin",
    HOME: "/Users/example",
    GITHUB_TOKEN: "ghp_parent_secret",
    CIRCLECI_TOKEN: "circleci_parent_secret",
    LINEAR_API_KEY: "linear_parent_secret",
  },
  values: {
    AGENTRAIL_RUN_ID: "run_1",
    AGENTRAIL_BASE_URL: "http://127.0.0.1:3000",
    AGENTRAIL_RUN_CONTEXT_TOKEN: "arrun_context",
  },
};

test("normalizeRunnerExecutionPolicy returns strict AgentRail-owned defaults", () => {
  const policy = normalizeRunnerExecutionPolicy(undefined);

  assert.equal(policy.preset, "strict");
  assert.equal(policy.enforcementMode, "strict");
  assert.equal(policy.network.mode, "agentrail_local_only");
  assert.equal(policy.publish.mode, "agentrail_owned");
  assert.equal(policy.credentials.inherit, "none");
  assert.deepEqual(policy.filesystem.extraWritablePaths, []);
});

test("buildRunnerPolicyEnv strips provider credentials and keeps run scoped values", () => {
  const env = buildRunnerPolicyEnv(basePlanInput.baseEnv, basePlanInput.values, DEFAULT_RUNNER_EXECUTION_POLICY);

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/example");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CIRCLECI_TOKEN, undefined);
  assert.equal(env.LINEAR_API_KEY, undefined);
  assert.equal(env.AGENTRAIL_RUN_ID, "run_1");
  assert.equal(env.AGENTRAIL_BASE_URL, "http://127.0.0.1:3000");
  assert.equal(env.AGENTRAIL_RUN_CONTEXT_TOKEN, "arrun_context");
});

test("compileRunnerExecutionPlan maps strict Codex policy to sandboxed exec args", () => {
  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
  });

  assert.equal(validateRunnerPolicyPlan(plan).ok, true);
  assert.equal(plan.executable, "codex");
  assert.deepEqual(plan.args.slice(0, 4), ["-a", "never", "-c", "shell_environment_policy.inherit=core"]);
  assert.ok(plan.args.includes("--sandbox"));
  assert.ok(plan.args.includes("workspace-write"));
  assert.ok(plan.args.includes("--ephemeral"));
  assert.ok(plan.args.includes("--ignore-user-config"));
  assert.ok(plan.args.includes("--ignore-rules"));
  assert.ok(plan.args.includes("features.hooks=false"));
  assert.equal(plan.args.includes("hooks=false"), false);
  assert.ok(plan.args.includes("--add-dir"));
  assert.ok(plan.args.includes("/tmp/run"));
  assert.equal(plan.args.includes("shell_environment_policy.inherit=all"), false);
  assert.equal(plan.env.AGENTRAIL_RUN_CONTEXT_TOKEN, "arrun_context");
  assert.equal(plan.args.join("\n").includes("AGENTRAIL_RUN_CONTEXT_TOKEN"), false);
  assert.equal(plan.args.join("\n").includes("arrun_context"), false);
  assert.equal(plan.env.GITHUB_TOKEN, undefined);
});

test("compileRunnerExecutionPlan writes generated Claude settings", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-claude-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "claude-code",
    runDir: tempDir,
    recipePath: path.join(tempDir, "agent-recipes.md"),
  });

  assert.equal(validateRunnerPolicyPlan(plan).ok, true);
  assert.equal(plan.executable, "claude");
  assert.ok(plan.args.includes("--settings"));
  assert.ok(plan.args.includes(path.join(tempDir, "claude-settings.json")));
  assert.ok(plan.args.includes("--append-system-prompt-file"));

  await writeRunnerPolicyGeneratedFiles(plan);
  const settings = JSON.parse(await readFile(path.join(tempDir, "claude-settings.json"), "utf8"));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(basePlanInput.worktreePath));
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(tempDir));
  assert.ok(settings.permissions.deny.some((entry: string) => entry.includes("git push")));
});

test("Codex filesystem preflight blocks denied files that the sandbox cannot hide", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-denied-preflight-"));
  const worktreePath = path.join(tempDir, "worktree");
  const runDir = path.join(tempDir, "run");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(worktreePath, ".env"), "SECRET=value\n", "utf8");

  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
    worktreePath,
    runDir,
    recipePath: path.join(runDir, "agent-recipes.md"),
  });

  const result = await validateRunnerPolicyFilesystemPreflight(plan);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "runner_policy_denied_files_present");
  assert.match(result.summary, /\.env/);
  assert.deepEqual(result.matches, [".env"]);
});

test("Codex filesystem post-run validation blocks denied write path changes", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-denied-postrun-"));
  const worktreePath = path.join(tempDir, "worktree");
  const runDir = path.join(tempDir, "run");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
    worktreePath,
    runDir,
    recipePath: path.join(runDir, "agent-recipes.md"),
  });

  const preflight = await validateRunnerPolicyFilesystemPreflight(plan);
  assert.equal(preflight.ok, true);

  await writeFile(path.join(worktreePath, ".env"), "SECRET=value\n", "utf8");
  const result = await validateRunnerPolicyFilesystemPostRun(plan, preflight.snapshot);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "runner_policy_violation");
  assert.match(result.summary, /created \.env/);
  assert.deepEqual(result.matches, ["created .env"]);
});

test("Codex filesystem post-run validation restores instruction file drift", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-instruction-drift-"));
  const worktreePath = path.join(tempDir, "worktree");
  const runDir = path.join(tempDir, "run");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(worktreePath, "AGENTS.md"), "Original project instructions\n", "utf8");

  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
    worktreePath,
    runDir,
    recipePath: path.join(runDir, "agent-recipes.md"),
  });

  const preflight = await validateRunnerPolicyFilesystemPreflight(plan);
  assert.equal(preflight.ok, true);

  await writeFile(path.join(worktreePath, "AGENTS.md"), "Injected external memory context\n", "utf8");
  const result = await validateRunnerPolicyFilesystemPostRun(plan, preflight.snapshot);

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.match(result.summary, /restored/);
  assert.deepEqual(result.matches, ["modified AGENTS.md"]);
  assert.equal(await readFile(path.join(worktreePath, "AGENTS.md"), "utf8"), "Original project instructions\n");
});

test("hardenProtectedInstructionFiles removes write bits from protected instruction files", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-harden-instructions-"));
  const worktreePath = path.join(tempDir, "worktree");
  const runDir = path.join(tempDir, "run");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const agentsPath = path.join(worktreePath, "AGENTS.md");
  await writeFile(agentsPath, "Original project instructions\n", { encoding: "utf8", mode: 0o644 });

  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
    worktreePath,
    runDir,
    recipePath: path.join(runDir, "agent-recipes.md"),
  });

  await hardenProtectedInstructionFiles(plan);

  const hardenedMode = (await stat(agentsPath)).mode & 0o777;
  assert.equal(hardenedMode & 0o222, 0);
});

test("Codex filesystem post-run validation restores original instruction file mode when content is unchanged", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-policy-instruction-mode-"));
  const worktreePath = path.join(tempDir, "worktree");
  const runDir = path.join(tempDir, "run");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const agentsPath = path.join(worktreePath, "AGENTS.md");
  await writeFile(agentsPath, "Original project instructions\n", { encoding: "utf8", mode: 0o644 });

  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "codex",
    worktreePath,
    runDir,
    recipePath: path.join(runDir, "agent-recipes.md"),
  });

  const preflight = await validateRunnerPolicyFilesystemPreflight(plan);
  assert.equal(preflight.ok, true);

  await hardenProtectedInstructionFiles(plan);
  assert.equal(((await stat(agentsPath)).mode & 0o777) & 0o222, 0);

  const result = await validateRunnerPolicyFilesystemPostRun(plan, preflight.snapshot);

  assert.equal(result.ok, true);
  assert.equal((await stat(agentsPath)).mode & 0o777, 0o644);
});

test("compileRunnerExecutionPlan rejects Cursor in strict mode without an external sandbox", () => {
  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "cursor",
  });

  const validation = validateRunnerPolicyPlan(plan);
  assert.equal(validation.ok, false);
  assert.match(validation.reasons.join("\n"), /network/i);
  assert.equal(plan.env.GITHUB_TOKEN, undefined);
  assert.equal(plan.manualContinuationAllowed, false);
});

test("compileRunnerExecutionPlan routes Cursor through an external sandbox wrapper", () => {
  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "cursor",
    policy: {
      preset: "external_sandbox",
      externalSandbox: {
        command: ["sandbox-runner", "--policy", "agentrail"],
      },
    },
  });

  assert.equal(validateRunnerPolicyPlan(plan).ok, true);
  assert.equal(plan.executable, "sandbox-runner");
  assert.deepEqual(plan.args.slice(0, 4), ["--policy", "agentrail", "cursor-agent", "-p"]);
  assert.equal(plan.manualContinuationAllowed, true);
});

test("compileRunnerExecutionPlan allows custom strict mode only through an external sandbox wrapper", () => {
  const plan = compileRunnerExecutionPlan({
    ...basePlanInput,
    runner: "devin",
    policy: {
      externalSandbox: {
        command: ["docker", "run", "--rm", "agentrail-runner"],
      },
    },
  });

  const validation = validateRunnerPolicyPlan(plan);
  assert.equal(validation.ok, false);
  assert.equal(plan.executable, "docker");
  assert.deepEqual(plan.args.slice(0, 4), ["run", "--rm", "agentrail-runner", "devin"]);
  assert.match(validation.reasons.join("\n"), /publish/i);
});

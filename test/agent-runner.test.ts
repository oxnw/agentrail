import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentRunStore } from "../src/agent-run-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { runCli } from "../src/cli/index.ts";
import { createSetupConfig } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";
import { TaskEventStore } from "../src/task-event-store.ts";
import { createMemoryWriter } from "./helpers/memory-writer.ts";

const now = () => new Date("2026-05-09T11:00:00.000Z");

interface PullRequestPayload {
  pullRequest?: {
    head?: string;
    base?: string;
    headSha?: string;
  };
}

interface AgentRailHandoff {
  target: "agentrail";
  summary: string;
  commitSha: string;
  checks?: unknown[];
  artifacts?: unknown[];
  pullRequest?: Record<string, unknown> | null;
}

interface UserHandoff {
  target: "user";
  summary: string;
  reason: string;
  actionRequired: string;
}

type HandoffPayload = AgentRailHandoff | UserHandoff;

function readPullRequestPayload(payload: unknown): PullRequestPayload["pullRequest"] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const pullRequest = (payload as PullRequestPayload).pullRequest;
  return typeof pullRequest === "object" && pullRequest !== null ? pullRequest : undefined;
}

test("agent run --once starts assigned work, records the run, and writes markdown notes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_runner_test",
          prUrl: "https://github.com/oxnw/agentrail/pull/123",
          prNumber: 123,
          head: pullRequest?.head,
          base: pullRequest?.base,
          headSha: pullRequest?.headSha,
        },
        availableActions: ["view_ci_status", "view_review_feedback"],
      };
    },
  });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, true);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-001",
    title: "Implement managed run",
    description: "Make sure the worker starts assigned tasks.",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
    AGENTRAIL_AGENT_RECIPE_PATH: path.join(homePath, "agent-recipes.md"),
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, prompt, env, handoffPath, worktreePath }) => {
        assert.equal(env.AGENTRAIL_BASE_URL, harness.baseUrl);
        assert.equal(env.AGENTRAIL_API_KEY, harness.apiKey);
        assert.equal(env.AGENTRAIL_AGENT_ID, "agt_runner");
        assert.equal(env.AGENTRAIL_HANDOFF_PATH, handoffPath);
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, prompt, "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "runner completed\n", "utf8");
        const commitSha = commitAll(worktreePath, "runner change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Runner completed in test.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner completed in test.",
        };
      },
      publishBranch: async ({ branchName, commitSha }) => {
        assert.equal(branchName, `agentrail/agt_runner/${task.id}`);
        assert.match(commitSha, /^[0-9a-f]{40}$/u);
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Run run_/);

  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "in_review");
  assert.deepEqual(storedTask?.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const runs = runStore.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, task.id);
  assert.equal(runs[0].status, "succeeded");
  assert.ok(runs[0].handoffPath, "handoffPath must be defined");
  assert.ok(runs[0].promptPath, "promptPath must be defined");
  assert.deepEqual(runs[0].launch, {
    executable: "codex",
    args: [
      "-a",
      "never",
      "-c",
      "shell_environment_policy.inherit=all",
      "exec",
      "--sandbox",
      "workspace-write",
      "--ignore-user-config",
      "--cd",
      runs[0].worktreePath,
      "--add-dir",
      path.dirname(runs[0].handoffPath),
      "--json",
      "-",
    ],
  });

  const promptText = await readFile(runs[0].promptPath, "utf8");
  assert.match(promptText, /AGEA-RUN-001/);
  assert.match(promptText, /Recipe file:/);
  assert.match(promptText, /Handoff file:/);
  assert.match(promptText, /agentrail agent report --status progress/);
  assert.match(promptText, /agentrail agent report --status completed/);
  assert.match(promptText, /handoff file is AgentRail's recovery path/);

  const notePath = path.join(homePath, "notes", "runs", `${runs[0].runId}.md`);
  const noteText = await readFile(notePath, "utf8");
  assert.match(noteText, /Runner completed in test/);
});

test("agent run skips setup verification tasks and starts real assigned work instead", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-setup-skip-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_real_task",
          prUrl: "https://github.com/oxnw/agentrail/pull/124",
          prNumber: 124,
          head: pullRequest?.head,
          base: pullRequest?.base,
          headSha: pullRequest?.headSha,
        },
        availableActions: ["view_ci_status", "view_review_feedback"],
      };
    },
  });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  harness.taskQueue.createTask({
    identifier: "LOCAL-SETUP-AGT-RUNNER",
    title: "Setup verification",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "in_progress",
    availableActions: ["submit"],
    source: {
      provider: "agentrail_setup",
      owner: "oxnw",
      repo: "agentrail",
    },
  });
  const realTask = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-REAL",
    title: "Real task",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath, worktreePath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, "runner output", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "real task completed\n", "utf8");
        const commitSha = commitAll(worktreePath, "real task change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Real task completed.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner completed in test.",
        };
      },
      publishBranch: async () => {},
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  const setupTask = harness.taskQueue.findTaskByIdentifier("LOCAL-SETUP-AGT-RUNNER");
  assert.equal(setupTask?.status, "in_progress");
  assert.equal(harness.taskQueue.getRawTask(realTask.id)?.status, "in_review");
});

test("agent run consumes a completion handoff reported through AgentRail API", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-api-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_reported_handoff",
          prUrl: "https://github.com/oxnw/agentrail/pull/125",
          prNumber: 125,
          head: pullRequest?.head,
          base: pullRequest?.base,
          headSha: pullRequest?.headSha,
        },
        availableActions: ["view_ci_status", "view_review_feedback"],
      };
    },
    agentRunStorePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-API",
    title: "Report completion through AgentRail",
    description: "Use AgentRail reporting instead of only the handoff file.",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ env, logPath, worktreePath }) => {
        assert.match(env.AGENTRAIL_RUN_ID ?? "", /^run_/u);
        await writeFile(logPath, "reported through AgentRail API\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "runner reported through API\n", "utf8");
        const commitSha = commitAll(worktreePath, "runner api report");
        const response = await fetch(`${env.AGENTRAIL_BASE_URL}/agent-runs/${env.AGENTRAIL_RUN_ID}/report`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.AGENTRAIL_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "completed",
            summary: "Reported completion through AgentRail API.",
            handoff: {
              version: 1,
              target: "agentrail",
              summary: "Reported completion through AgentRail API.",
              commitSha,
            },
          }),
        });
        assert.equal(response.status, 202, await response.text());
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Reported completion through AgentRail API.",
        };
      },
      publishBranch: async ({ branchName, commitSha }) => {
        assert.equal(branchName, `agentrail/agt_runner/${task.id}`);
        assert.match(commitSha, /^[0-9a-f]{40}$/u);
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_review");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "succeeded");
  assert.equal(run.reports[0].status, "completed");
  assert.equal(run.reportedHandoff?.target, "agentrail");
});

test("agent report posts progress using runner environment", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  runStore.createRun({
    runId: "run_cli_report",
    agentId: "agt_runner",
    runner: "codex",
    taskId: "tsk_cli_report",
    taskIdentifier: "github:oxnw/agentrail:issues/report",
    status: "running",
    repoPath: repoRoot,
    worktreePath: path.join(homePath, "worktrees", "agt_runner", "run_cli_report"),
    branchName: "agentrail/agt_runner/tsk_cli_report",
    promptPath: null,
    logPath: null,
    handoffPath: null,
    createdAt: "2026-05-09T11:00:00.000Z",
    startedAt: "2026-05-09T11:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-09T11:00:01.000Z",
    exitCode: null,
    summary: null,
    launch: {
      executable: "codex",
      args: ["exec"],
    },
  });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousEnv = {
    AGENTRAIL_HOME: process.env.AGENTRAIL_HOME,
    AGENTRAIL_BASE_URL: process.env.AGENTRAIL_BASE_URL,
    AGENTRAIL_API_KEY: process.env.AGENTRAIL_API_KEY,
    AGENTRAIL_RUN_ID: process.env.AGENTRAIL_RUN_ID,
  };
  process.env.AGENTRAIL_HOME = homePath;
  process.env.AGENTRAIL_BASE_URL = harness.baseUrl;
  process.env.AGENTRAIL_API_KEY = harness.apiKey;
  process.env.AGENTRAIL_RUN_ID = "run_cli_report";

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await harness.close();
  });

  const exitCode = await runCli([
    "agent",
    "report",
    "--status",
    "progress",
    "--summary",
    "Finished implementation and started tests.",
  ], {
    cwd: repoRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Reported progress/);
  const reported = new AgentRunStore({ storagePath: agentRunStorePath }).getRun("run_cli_report");
  assert.equal(reported?.reports[0].summary, "Finished implementation and started tests.");
});

test("agent report writes a local report file inside managed runner env", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-local-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const reportPath = path.join(homePath, "runs", "run_local_report", "reports.jsonl");
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousEnv = {
    AGENTRAIL_HOME: process.env.AGENTRAIL_HOME,
    AGENTRAIL_BASE_URL: process.env.AGENTRAIL_BASE_URL,
    AGENTRAIL_API_KEY: process.env.AGENTRAIL_API_KEY,
    AGENTRAIL_RUN_ID: process.env.AGENTRAIL_RUN_ID,
    AGENTRAIL_RUN_REPORT_PATH: process.env.AGENTRAIL_RUN_REPORT_PATH,
  };
  process.env.AGENTRAIL_HOME = homePath;
  delete process.env.AGENTRAIL_BASE_URL;
  delete process.env.AGENTRAIL_API_KEY;
  process.env.AGENTRAIL_RUN_ID = "run_local_report";
  process.env.AGENTRAIL_RUN_REPORT_PATH = reportPath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const exitCode = await runCli([
    "agent",
    "report",
    "--status",
    "progress",
    "--summary",
    "Local report written without HTTP.",
    "--json",
  ], {
    cwd: repoRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.deepEqual(JSON.parse(stdout.toString()), {
    data: {
      runId: "run_local_report",
      status: "progress",
    },
    availableActions: [],
  });
  const lines = (await readFile(reportPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    version: 1,
    runId: "run_local_report",
    status: "progress",
    summary: "Local report written without HTTP.",
  });
});

test("agent run preserves API-reported blockers without requiring a handoff file", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-api-blocked-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({ agentRunStorePath: path.join(homePath, "stores", "agent-runs.json") });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-BLOCKED",
    title: "Report blocker through AgentRail",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ env, logPath }) => {
        await writeFile(logPath, "blocked by missing token\n", "utf8");
        const response = await fetch(`${env.AGENTRAIL_BASE_URL}/agent-runs/${env.AGENTRAIL_RUN_ID}/report`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.AGENTRAIL_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            status: "blocked",
            summary: "Missing GitHub token; user needs to reconnect GitHub.",
          }),
        });
        assert.equal(response.status, 202, await response.text());
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Blocked.",
        };
      },
      publishBranch: async () => {
        throw new Error("publish should not run for blocked reports");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_progress");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "waiting_for_human");
  assert.match(run.summary ?? "", /Missing GitHub token/);
});

test("agent run consumes local report files written by managed runners", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-local-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({ agentRunStorePath: path.join(homePath, "stores", "agent-runs.json") });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-LOCAL-BLOCKED",
    title: "Report blocker through local report file",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ env, logPath }) => {
        const reportPath = env.AGENTRAIL_RUN_REPORT_PATH;
        assert.ok(reportPath, "AGENTRAIL_RUN_REPORT_PATH must be defined");
        assert.match(reportPath, /reports\.jsonl$/u);
        await writeFile(logPath, "blocked through local report file\n", "utf8");
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify({
          version: 1,
          runId: env.AGENTRAIL_RUN_ID,
          status: "blocked",
          summary: "Local report says user needs to reconnect GitHub.",
        })}\n`, "utf8");
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Blocked.",
        };
      },
      publishBranch: async () => {
        throw new Error("publish should not run for local blocked reports");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_progress");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "waiting_for_human");
  assert.equal(run.reports[0].status, "blocked");
  assert.match(run.summary ?? "", /reconnect GitHub/);
});

test("agent run honors local blocked reports even when the runner fails", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-local-report-failed-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({ agentRunStorePath: path.join(homePath, "stores", "agent-runs.json") });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-LOCAL-BLOCKED-FAILED",
    title: "Report blocker before failing",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ env, logPath }) => {
        const reportPath = env.AGENTRAIL_RUN_REPORT_PATH;
        assert.ok(reportPath, "AGENTRAIL_RUN_REPORT_PATH must be defined");
        await writeFile(logPath, "blocked before failed exit\n", "utf8");
        await writeFile(reportPath, `${JSON.stringify({
          version: 1,
          runId: env.AGENTRAIL_RUN_ID,
          status: "blocked",
          summary: "Local report before failure says user must reconnect GitHub.",
        })}\n`, "utf8");
        return {
          status: "failed",
          exitCode: 1,
          summary: "Runner failed after reporting blocker.",
        };
      },
      publishBranch: async () => {
        throw new Error("publish should not run for failed blocked reports");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_progress");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "waiting_for_human");
  assert.equal(run.reports[0].status, "blocked");
  assert.match(run.summary ?? "", /reconnect GitHub/);
});

test("agent run respects max concurrent task capacity from the agent env", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-capacity-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  runStore.createRun({
    runId: "run_active",
    agentId: "agt_runner",
    runner: "codex",
    taskId: "tsk_active",
    taskIdentifier: "github:oxnw/agentrail:issues/active",
    status: "running",
    repoPath: repoRoot,
    worktreePath: path.join(homePath, "worktrees", "agt_runner", "run_active"),
    branchName: "agentrail/agt_runner/tsk_active",
    promptPath: null,
    logPath: null,
    handoffPath: null,
    createdAt: "2026-05-09T11:00:00.000Z",
    startedAt: "2026-05-09T11:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-09T11:00:01.000Z",
    exitCode: null,
    summary: null,
    launch: {
      executable: "codex",
      args: ["exec"],
    },
  });
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-002",
    title: "Second task",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once", "--json"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async () => {
        throw new Error("prepareWorktree should not be called when capacity is reached");
      },
      launchRunner: async () => {
        throw new Error("launchRunner should not be called when capacity is reached");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /capacity_reached/);
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "todo");
});

test("agent run marks the run failed when worktree setup fails before launch", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-worktree-fail-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  harness.taskQueue.createTask({
    identifier: "AGEA-RUN-003",
    title: "Broken worktree task",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async () => {
        throw new Error("worktree setup failed");
      },
      launchRunner: async () => {
        throw new Error("launchRunner should not be called when worktree setup fails");
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /worktree setup failed/);

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.ok(run);
  assert.equal(run.status, "failed");
  assert.match(run.summary ?? "", /worktree setup failed/);
});

test("agent run marks a zero-exit runner as failed when it does not write a handoff", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-no-progress-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  harness.taskQueue.createTask({
    identifier: "AGEA-RUN-004",
    title: "No progress task",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await mkdir(worktreePath, { recursive: true });
      },
      launchRunner: async ({ logPath }) => {
        await writeFile(logPath, "runner output", "utf8");
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner completed in test.",
        };
      },
    },
  });

  assert.equal(exitCode, 1);
  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.ok(run);
  assert.equal(run.status, "failed");
  assert.match(run.summary ?? "", /handoff file/i);
});

test("agent run records a user handoff without submitting the task", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-user-handoff-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-USER",
    title: "Needs user action",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, "missing tool", "utf8");
        await writeAgentRailHandoff(handoffPath, {
          target: "user",
          summary: "Could not validate the task.",
          reason: "missing_tool",
          actionRequired: "Install the required local validator.",
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner needs user action.",
        };
      },
      publishBranch: async () => {
        throw new Error("publish should not run for user handoff");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_progress");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.ok(run);
  assert.equal(run.status, "waiting_for_human");
  assert.match(run.summary ?? "", /Install the required local validator/);
});

test("agent status reads the persisted run store", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-status-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
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
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    baseUrl: "http://127.0.0.1:3000",
    providerMode: "disabled",
  });
  await writeSetupFiles({ homePath, config });

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  runStore.createRun({
    runId: "run_status",
    agentId: "agt_runner",
    runner: "codex",
    taskId: "tsk_status",
    taskIdentifier: "github:oxnw/agentrail:issues/21",
    status: "waiting_for_human",
    repoPath: repoRoot,
    worktreePath: path.join(homePath, "worktrees", "agt_runner", "run_status"),
    branchName: "agentrail/agt_runner/tsk_status",
    promptPath: null,
    logPath: null,
    handoffPath: path.join(homePath, "runs", "run_status", "handoff.json"),
    createdAt: "2026-05-09T11:00:00.000Z",
    startedAt: "2026-05-09T11:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-09T11:00:01.000Z",
    exitCode: null,
    summary: "Waiting for a human.",
    launch: {
      executable: "cursor",
      args: [repoRoot],
    },
  });

  const exitCode = await runCli(["agent", "status", "--json"], {
    cwd: repoRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const body = JSON.parse(stdout.toString());
  assert.equal(body.data[0].runId, "run_status");
  assert.equal(body.data[0].status, "waiting_for_human");
});

async function createHarness(options?: {
  submitTask?: (taskId: string, payload: unknown, idempotencyKey: string | undefined) => Promise<unknown>;
  agentRunStorePath?: string;
}) {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore, delegate: options });
  const authStore = new AgentAuthStore({ now });
  const { data } = authStore.createKey({
    agent: {
      id: "agt_runner",
      displayName: "Runner",
      role: "agent",
    },
    scopes: ["tasks:read", "tasks:write"],
  }, "key:runner");
  const server = createServer({
    store: eventStore,
    authStore,
    agentRunStore: options?.agentRunStorePath ? new AgentRunStore({ now, storagePath: options.agentRunStorePath }) : null,
    taskLifecycleStore: taskQueue,
    now,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server address.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    apiKey: data.apiKey,
    taskQueue,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writeSetupRepo(repoRoot: string, homePath: string, baseUrl: string, markdownExport: boolean) {
  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    baseUrl,
    providerMode: "disabled",
    markdownExport,
  });
  await writeSetupFiles({ homePath, config });
}

async function writeAgentEnv(homePath: string, values: Record<string, string>) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await writeFile(path.join(homePath, "agent.env"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function initGitWorktree(worktreePath: string): Promise<void> {
  await mkdir(worktreePath, { recursive: true });
  runGit(worktreePath, ["init"]);
  runGit(worktreePath, ["config", "user.email", "runner@example.com"]);
  runGit(worktreePath, ["config", "user.name", "Runner"]);
  await writeFile(path.join(worktreePath, "README.md"), "initial\n", "utf8");
  runGit(worktreePath, ["add", "README.md"]);
  runGit(worktreePath, ["commit", "-m", "initial"]);
}

function commitAll(worktreePath: string, message: string): string {
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["commit", "-m", message]);
  return runGit(worktreePath, ["rev-parse", "HEAD"]).trim();
}

function runGit(worktreePath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", worktreePath, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function writeAgentRailHandoff(
  handoffPath: string,
  handoff: HandoffPayload,
): Promise<void> {
  await writeFile(handoffPath, `${JSON.stringify({ version: 1, ...handoff }, null, 2)}\n`, "utf8");
}

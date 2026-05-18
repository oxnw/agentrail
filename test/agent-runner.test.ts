import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentRunStore } from "../src/agent-run-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { runAgentReport } from "../src/cli/agent-runner.ts";
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
  commitSha?: string;
  checks?: unknown[];
  artifacts?: unknown[];
  pullRequest?: Record<string, unknown> | null;
}

interface UserHandoff {
  target: "user";
  summary: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
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
  const previousSensitiveEnv = {
    AGENTRAIL_OPERATOR_KEY: process.env.AGENTRAIL_OPERATOR_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    CIRCLECI_TOKEN: process.env.CIRCLECI_TOKEN,
    LINEAR_API_KEY: process.env.LINEAR_API_KEY,
  };
  process.env.AGENTRAIL_HOME = homePath;
  process.env.AGENTRAIL_OPERATOR_KEY = "ar_live_operator_secret";
  process.env.GITHUB_TOKEN = "ghp_parent_secret";
  process.env.GITHUB_WEBHOOK_SECRET = "github_webhook_secret";
  process.env.CIRCLECI_TOKEN = "circleci_parent_secret";
  process.env.LINEAR_API_KEY = "linear_parent_secret";

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    for (const [key, value] of Object.entries(previousSensitiveEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, true);
  const staleRecipePath = path.join(homePath, "stale-agent-recipes.md");
  await writeFile(
    staleRecipePath,
    [
      "# Stale AgentRail Recipe",
      "",
      "Begin with:",
      "GET /tasks/mine?status=in_progress&limit=1",
      "Then GET /tasks/{taskId}/ci-status and GET /tasks/{taskId}/review-feedback.",
      "",
    ].join("\n"),
    "utf8",
  );
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
    AGENTRAIL_AGENT_RECIPE_PATH: staleRecipePath,
  });

  const exitCode = await runCli(["agent", "run", "--once"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, prompt, env, handoffPath, worktreePath, recipePath, executable, args }) => {
        assert.equal(executable, "codex");
        assert.ok(args.includes("--ignore-user-config"));
        assert.ok(args.includes("--ignore-rules"));
        assert.ok(args.includes("features.hooks=false"));
        assert.equal(args.includes("hooks=false"), false);
        assert.ok(args.includes("--sandbox"));
        assert.ok(args.includes("workspace-write"));
        assert.equal(args.includes("shell_environment_policy.inherit=all"), false);
        assert.equal(env.AGENTRAIL_BASE_URL, harness.baseUrl);
        assert.equal(env.AGENTRAIL_API_KEY, undefined);
        assert.equal(env.AGENTRAIL_OPERATOR_KEY, undefined);
        assert.equal(env.GITHUB_TOKEN, undefined);
        assert.equal(env.GITHUB_WEBHOOK_SECRET, undefined);
        assert.equal(env.CIRCLECI_TOKEN, undefined);
        assert.equal(env.LINEAR_API_KEY, undefined);
        assert.equal(env.AGENTRAIL_AGENT_ID, "agt_runner");
        assert.equal(env.AGENTRAIL_HANDOFF_PATH, handoffPath);
        assert.match(env.AGENTRAIL_RUN_ID ?? "", /^run_/u);
        assert.match(env.AGENTRAIL_RUN_CONTEXT_TOKEN ?? "", /^arrun_/u);
        assert.equal(args.join("\n").includes("AGENTRAIL_RUN_CONTEXT_TOKEN"), false);
        assert.equal(args.join("\n").includes(env.AGENTRAIL_RUN_CONTEXT_TOKEN ?? ""), false);
        const runContextPath = env.AGENTRAIL_RUN_CONTEXT_PATH;
        assert.ok(runContextPath, "AGENTRAIL_RUN_CONTEXT_PATH must be defined");
        const context = JSON.parse(await readFile(runContextPath, "utf8"));
        assert.equal(context.data.run.runId, env.AGENTRAIL_RUN_ID);
        assert.equal(context.data.task.id, task.id);
        assert.deepEqual(context.availableActions, ["submit"]);
        assert.ok(recipePath, "managed recipePath must be defined");
        assert.notEqual(recipePath, staleRecipePath);
        const recipeText = await readFile(recipePath, "utf8");
        assert.doesNotMatch(recipeText, /GET \/tasks\/mine/);
        assert.doesNotMatch(recipeText, /GET \/tasks\/\{taskId\}\/ci-status/);
        assert.doesNotMatch(recipeText, /GET \/tasks\/\{taskId\}\/review-feedback/);
        assert.doesNotMatch(prompt, /GET \/tasks\/mine/);
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
  assert.deepEqual(storedTask?.availableActions, ["view_ci_status", "view_review_feedback"]);

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const runs = runStore.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, task.id);
  assert.equal(runs[0].status, "succeeded");
  assert.match(runs[0].runContextTokenHash ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(runs[0].runContextTokenHash?.startsWith("arrun_"), false);
  assert.ok(runs[0].runContextTokenIssuedAt);
  assert.ok(runs[0].handoffPath, "handoffPath must be defined");
  assert.ok(runs[0].promptPath, "promptPath must be defined");
  assert.equal(runs[0].launch.executable, "codex");
  assert.deepEqual(runs[0].launch.args.slice(0, 4), ["-a", "never", "-c", "shell_environment_policy.inherit=core"]);
  assert.ok(runs[0].launch.args.includes("exec"));
  assert.ok(runs[0].launch.args.includes("--sandbox"));
  assert.ok(runs[0].launch.args.includes("workspace-write"));
  assert.ok(runs[0].launch.args.includes("--ignore-user-config"));
  assert.ok(runs[0].launch.args.includes("--ignore-rules"));
  assert.ok(runs[0].launch.args.includes("features.hooks=false"));
  assert.equal(runs[0].launch.args.includes("hooks=false"), false);
  assert.ok(runs[0].launch.args.includes("--cd"));
  assert.ok(runs[0].launch.args.includes(runs[0].worktreePath));
  assert.ok(runs[0].launch.args.includes("--add-dir"));
  assert.ok(runs[0].launch.args.includes(path.dirname(runs[0].handoffPath)));
  assert.ok(runs[0].launch.args.includes("--json"));
  assert.ok(runs[0].launch.args.includes("-"));
  assert.equal(runs[0].launch.args.includes("shell_environment_policy.inherit=all"), false);
  assert.equal(runs[0].launch.args.join("\n").includes("AGENTRAIL_RUN_CONTEXT_TOKEN"), false);

  const promptText = await readFile(runs[0].promptPath, "utf8");
  assert.match(promptText, /AGEA-RUN-001/);
  assert.match(promptText, /Recipe file:/);
  assert.match(promptText, /Handoff file:/);
  assert.match(promptText, /Run context file:/);
  assert.match(promptText, /agentrail run current/);
  assert.match(promptText, /agentrail run actions/);
  assert.match(promptText, /agentrail agent report --status progress/);
  assert.match(promptText, /agentrail agent report --status completed/);
  assert.match(promptText, /handoff file is AgentRail's recovery path/);

  const notePath = path.join(homePath, "notes", "runs", `${runs[0].runId}.md`);
  const noteText = await readFile(notePath, "utf8");
  assert.match(noteText, /Runner completed in test/);
});

test("agent run waits on task events instead of sleeping and polling when idle", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-events-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_event_wake",
          prUrl: "https://github.com/oxnw/agentrail/pull/125",
          prNumber: 125,
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
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  let mineRequests = 0;
  let streamRequests = 0;
  let injectedTaskId: string | null = null;
  let eventScheduled = false;
  const fetchWithEventInjection: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/tasks/mine") {
      mineRequests += 1;
    }
    if (url.pathname === "/task-events/stream") {
      streamRequests += 1;
      if (!eventScheduled) {
        eventScheduled = true;
        setTimeout(() => {
          const task = harness.taskQueue.createTask({
            identifier: "AGEA-RUN-EVENT",
            title: "Wake from event",
            assignee: { id: "agt_runner", name: "Runner" },
            assigneeAgentId: "agt_runner",
            status: "todo",
            availableActions: ["start"],
          });
          injectedTaskId = task.id;
          void harness.eventStore.append({
            id: "evt_agent_run_wake",
            type: "task.updated",
            occurredAt: now().toISOString(),
            taskVersion: task.version,
            traceId: "trace_agent_run_wake",
            data: {
              taskId: task.id,
              taskIdentifier: task.identifier,
              status: task.status,
              changedFields: ["status", "availableActions"],
              availableActions: task.availableActions,
              affectedAgentId: "agt_runner",
            },
          });
        }, 25);
      }
    }
    return globalThis.fetch(input, init);
  };

  const runPromise = runCli(["agent", "run", "--max-runs", "1"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      fetch: fetchWithEventInjection,
      sleep: async () => {
        throw new Error("agent run should wait on task events instead of idle sleep polling");
      },
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath, worktreePath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, "event wake run\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "event wake completed\n", "utf8");
        const commitSha = commitAll(worktreePath, "event wake change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Runner woke from an AgentRail event.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner woke from an AgentRail event.",
        };
      },
      publishBranch: async () => {},
    },
  });

  const exitCode = await Promise.race([
    runPromise,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("agent run did not wake from task event")), 2_000)),
  ]);

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(streamRequests, 1);
  assert.equal(mineRequests, 6);
  assert.ok(injectedTaskId);
  assert.equal(harness.taskQueue.getRawTask(injectedTaskId)?.status, "in_review");
});

test("agent run without --once stays alive for later task events", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-resident-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: `sub_resident_${taskId}`,
          prUrl: `https://github.com/oxnw/agentrail/pull/${taskId}`,
          prNumber: 128,
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
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  const firstTask = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-RESIDENT-1",
    title: "Resident runner first task",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  let secondTaskId: string | null = null;
  let streamRequests = 0;
  let launchCount = 0;
  const fetchWithSecondEvent: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/task-events/stream") {
      streamRequests += 1;
      if (streamRequests === 1) {
        setTimeout(() => {
          const task = harness.taskQueue.createTask({
            identifier: "AGEA-RUN-RESIDENT-2",
            title: "Resident runner second task",
            assignee: { id: "agt_runner", name: "Runner" },
            assigneeAgentId: "agt_runner",
            status: "todo",
            availableActions: ["start"],
          });
          secondTaskId = task.id;
          void harness.eventStore.append({
            id: "evt_agent_run_resident_second",
            type: "task.updated",
            occurredAt: now().toISOString(),
            taskVersion: task.version,
            traceId: "trace_agent_run_resident_second",
            data: {
              taskId: task.id,
              taskIdentifier: task.identifier,
              status: task.status,
              changedFields: ["status", "availableActions"],
              availableActions: task.availableActions,
              affectedAgentId: "agt_runner",
            },
          });
        }, 25);
      } else {
        return new Response("forced stream stop after resident runner proof", { status: 500 });
      }
    }
    return globalThis.fetch(input, init);
  };

  const runPromise = runCli(["agent", "run", "--poll-interval", "1"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      fetch: fetchWithSecondEvent,
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath, worktreePath }) => {
        launchCount += 1;
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, `resident run ${launchCount}\n`, "utf8");
        await writeFile(path.join(worktreePath, "README.md"), `resident run ${launchCount} completed\n`, "utf8");
        const commitSha = commitAll(worktreePath, `resident run ${launchCount} change`);
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: `Resident run ${launchCount} completed.`,
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: `Resident run ${launchCount} completed.`,
        };
      },
      publishBranch: async () => {},
    },
  });

  const exitCode = await Promise.race([
    runPromise,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("resident runner did not continue to the second task")), 4_000)),
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /forced stream stop after resident runner proof/);
  assert.equal(launchCount, 2);
  assert.equal(streamRequests, 2);
  assert.equal(harness.taskQueue.getRawTask(firstTask.id)?.status, "in_review");
  assert.ok(secondTaskId);
  assert.equal(harness.taskQueue.getRawTask(secondTaskId)?.status, "in_review");
});

test("agent run falls back to polling when a task event arrives before the stream connects", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-missed-event-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_missed_event",
          prUrl: "https://github.com/oxnw/agentrail/pull/127",
          prNumber: 127,
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
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });

  let mineRequests = 0;
  let mineBodiesRead = 0;
  let streamRequests = 0;
  let injectedTaskId: string | null = null;
  const fetchWithMissedEvent: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/tasks/mine") {
      mineRequests += 1;
      const response = await globalThis.fetch(input, init);
      const originalText = response.text.bind(response);
      (response as Response & { text: () => Promise<string> }).text = async () => {
        const body = await originalText();
        mineBodiesRead += 1;
        if (mineBodiesRead === 3) {
          const task = harness.taskQueue.createTask({
            identifier: "AGEA-RUN-MISSED-EVENT",
            title: "Wake after missed event",
            assignee: { id: "agt_runner", name: "Runner" },
            assigneeAgentId: "agt_runner",
            status: "todo",
            availableActions: ["start"],
          });
          injectedTaskId = task.id;
          await harness.eventStore.append({
            id: "evt_agent_run_missed_wake",
            type: "task.updated",
            occurredAt: now().toISOString(),
            taskVersion: task.version,
            traceId: "trace_agent_run_missed_wake",
            data: {
              taskId: task.id,
              taskIdentifier: task.identifier,
              status: task.status,
              changedFields: ["status", "availableActions"],
              availableActions: task.availableActions,
              affectedAgentId: "agt_runner",
            },
          });
        }
        return body;
      };
      return response;
    }
    if (url.pathname === "/task-events/stream") {
      streamRequests += 1;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1_500);
      return globalThis.fetch(input, { ...init, signal: controller.signal });
    }
    return globalThis.fetch(input, init);
  };

  const runPromise = runCli(["agent", "run", "--max-runs", "1", "--poll-interval", "1"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      fetch: fetchWithMissedEvent,
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath, worktreePath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, "missed event fallback run\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "missed event completed\n", "utf8");
        const commitSha = commitAll(worktreePath, "missed event fallback change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Runner recovered by polling after a missed event.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner recovered by polling after a missed event.",
        };
      },
      publishBranch: async () => {},
    },
  });

  const exitCode = await Promise.race([
    runPromise,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("agent run did not recover from a missed task event")), 4_000)),
  ]);

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(streamRequests, 1);
  assert.ok(mineRequests >= 6);
  assert.ok(injectedTaskId);
  assert.equal(harness.taskQueue.getRawTask(injectedTaskId)?.status, "in_review");
});

test("agent run wakes on review changes requested events", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-review-events-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness({
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_review_wake",
          prUrl: "https://github.com/oxnw/agentrail/pull/126",
          prNumber: 126,
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
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "codex",
    AGENTRAIL_MAX_CONCURRENT_TASKS: "1",
    AGENTRAIL_REPO_ALLOWLIST: "oxnw/agentrail",
  });
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-REVIEW",
    title: "Wake from review changes",
    description: "Wake a waiting runner when review requests changes.",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "in_review",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "approved",
  });

  let streamRequests = 0;
  let reviewProjected = false;
  const fetchWithReviewEventInjection: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/task-events/stream") {
      streamRequests += 1;
      assert.match(url.searchParams.get("eventTypes") ?? "", /task\.review_changes_requested/);
      if (!reviewProjected) {
        reviewProjected = true;
        setTimeout(() => {
          void harness.taskQueue.projectReviewState(task.id, {
            outcome: "changes_requested",
            summary: "Please update the parser.",
            reviewer: "reviewer",
            updatedAt: "2026-05-09T11:01:00.000Z",
          });
        }, 25);
      }
    }
    return globalThis.fetch(input, init);
  };

  const runPromise = runCli(["agent", "run", "--max-runs", "1"], {
    cwd: repoRoot,
    stdout,
    stderr,
    agentRunner: {
      fetch: fetchWithReviewEventInjection,
      sleep: async () => {
        throw new Error("agent run should wait on task review events instead of idle sleep polling");
      },
      prepareWorktree: async ({ worktreePath }) => {
        await initGitWorktree(worktreePath);
      },
      launchRunner: async ({ logPath, handoffPath, worktreePath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        await writeFile(logPath, "review wake run\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "review wake completed\n", "utf8");
        const commitSha = commitAll(worktreePath, "review wake change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Runner woke from a review change event.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner woke from a review change event.",
        };
      },
      publishBranch: async () => {},
    },
  });

  const exitCode = await Promise.race([
    runPromise,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("agent run did not wake from review change event")), 2_000)),
  ]);

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(streamRequests, 1);
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_review");
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

test("agent run consumes a completion handoff reported through the managed local report file", async (t) => {
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
        assert.equal(env.AGENTRAIL_BASE_URL, harness.baseUrl);
        assert.equal(env.AGENTRAIL_API_KEY, undefined);
        assert.ok(env.AGENTRAIL_RUN_REPORT_PATH, "AGENTRAIL_RUN_REPORT_PATH must be defined");
        await writeFile(logPath, "reported through managed local report\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "runner reported locally\n", "utf8");
        const commitSha = commitAll(worktreePath, "runner api report");
        await writeFile(env.AGENTRAIL_RUN_REPORT_PATH, `${JSON.stringify({
          version: 1,
          runId: env.AGENTRAIL_RUN_ID,
          status: "completed",
          summary: "Reported completion through the managed local report.",
          handoff: {
            version: 1,
            target: "agentrail",
            summary: "Reported completion through the managed local report.",
            commitSha,
          },
        })}\n`, "utf8");
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Reported completion through the managed local report.",
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

test("agent run default workspace keeps git metadata and runner mailbox inside the writable worktree", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-default-workspace-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({
    agentRunStorePath,
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_default_workspace",
          prUrl: "https://github.com/oxnw/agentrail/pull/626",
          prNumber: 626,
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

  await initGitWorktree(repoRoot);
  runGit(repoRoot, ["remote", "add", "origin", "https://github.com/oxnw/agentrail.git"]);
  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-DEFAULT-WORKSPACE",
    title: "Use default managed workspace",
    description: "The child should edit, validate, and report without writing outside the worktree.",
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
      launchRunner: async ({ env, logPath, handoffPath, worktreePath, prompt, recipePath }) => {
        assert.ok(handoffPath, "handoffPath must be defined");
        assert.ok(recipePath, "recipePath must be defined");
        assert.ok(env.AGENTRAIL_RUN_REPORT_PATH, "AGENTRAIL_RUN_REPORT_PATH must be defined");
        const mailboxDir = path.join(worktreePath, ".agentrail-run");
        assert.equal(path.dirname(handoffPath), mailboxDir);
        assert.equal(path.dirname(env.AGENTRAIL_RUN_REPORT_PATH), mailboxDir);
        assert.equal(env.AGENTRAIL_HANDOFF_PATH, handoffPath);
        assert.match(prompt, /AgentRail will commit and publish/u);
        assert.doesNotMatch(prompt, /commit locally/u);
        const recipe = await readFile(recipePath, "utf8");
        assert.match(recipe, /Leave completed worktree changes in place for AgentRail to commit/u);
        assert.doesNotMatch(recipe, /Commit locally when/u);
        assert.equal((await lstat(path.join(worktreePath, ".git"))).isDirectory(), true);
        assert.match(await readFile(path.join(worktreePath, ".git", "info", "exclude"), "utf8"), /\.agentrail-run\//u);

        await writeFile(logPath, "default workspace completed\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "default workspace completed\n", "utf8");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Default workspace completed.",
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Default workspace completed.",
        };
      },
      publishBranch: async ({ branchName, commitSha, worktreePath }) => {
        assert.equal(branchName, `agentrail/agt_runner/${task.id}`);
        assert.match(commitSha, /^[0-9a-f]{40}$/u);
        assert.equal(runGit(worktreePath, ["cat-file", "-t", commitSha]), "commit\n");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_review");
  const [run] = new AgentRunStore({ storagePath: agentRunStorePath }).listRuns();
  assert.equal(run.status, "succeeded");
  assert.ok(run.handoffPath, "archived handoff path must be recorded");
  assert.equal(path.dirname(run.handoffPath), path.join(homePath, "runs", run.runId));
  assert.match(await readFile(run.handoffPath, "utf8"), /Default workspace completed/u);
  const committedReadme = runGit(path.join(homePath, "worktrees", "agt_runner", run.runId), ["show", "HEAD:README.md"]);
  assert.equal(committedReadme, "default workspace completed\n");
});

test("agent report posts progress using runner environment", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({
    agentRunStorePath,
    submitTask: async (taskId) => ({
      data: {
        taskId,
        submissionId: "sub_resolved_blocker",
        prUrl: "https://github.com/oxnw/agentrail/pull/456",
        prNumber: 456,
      },
      availableActions: ["view_ci_status", "view_review_feedback"],
    }),
  });
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

test("agent report writes blocked metadata to local report files", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-local-blocked-report-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const reportPath = path.join(homePath, "runs", "run_local_blocked_report", "reports.jsonl");
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
  process.env.AGENTRAIL_RUN_ID = "run_local_blocked_report";
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
    "blocked",
    "--summary",
    "Missing GitHub token.",
    "--reason",
    "missing_github_token",
    "--action-required",
    "Reconnect GitHub.",
    "--resume-instructions",
    "Retry the task after GitHub is reconnected.",
    "--json",
  ], {
    cwd: repoRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.deepEqual(JSON.parse(stdout.toString()), {
    data: {
      runId: "run_local_blocked_report",
      status: "blocked",
    },
    availableActions: [],
  });
  const lines = (await readFile(reportPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    version: 1,
    runId: "run_local_blocked_report",
    status: "blocked",
    summary: "Missing GitHub token.",
    reason: "missing_github_token",
    actionRequired: "Reconnect GitHub.",
    resumeInstructions: "Retry the task after GitHub is reconnected.",
  });
});

test("agent report posts blocked metadata using runner environment", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-report-blocked-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const previousEnv = {
    AGENTRAIL_BASE_URL: process.env.AGENTRAIL_BASE_URL,
    AGENTRAIL_API_KEY: process.env.AGENTRAIL_API_KEY,
    AGENTRAIL_RUN_ID: process.env.AGENTRAIL_RUN_ID,
    AGENTRAIL_RUN_REPORT_PATH: process.env.AGENTRAIL_RUN_REPORT_PATH,
  };
  process.env.AGENTRAIL_BASE_URL = "https://agentrail.example";
  process.env.AGENTRAIL_API_KEY = "key_runner";
  process.env.AGENTRAIL_RUN_ID = "run_http_blocked_report";
  delete process.env.AGENTRAIL_RUN_REPORT_PATH;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const exitCode = await runAgentReport([
    "--status",
    "blocked",
    "--summary",
    "Missing GitHub token.",
    "--reason",
    "missing_github_token",
    "--action-required",
    "Reconnect GitHub.",
    "--resume-instructions",
    "Retry the task after GitHub is reconnected.",
  ], {
    cwd: repoRoot,
    stdout,
    stderr,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: { runId: "run_http_blocked_report" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://agentrail.example/agent-runs/run_http_blocked_report/report");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    status: "blocked",
    summary: "Missing GitHub token.",
    reason: "missing_github_token",
    actionRequired: "Reconnect GitHub.",
    resumeInstructions: "Retry the task after GitHub is reconnected.",
  });
});

test("agent run preserves locally reported blockers without requiring a handoff file", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-api-blocked-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
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
        assert.equal(env.AGENTRAIL_BASE_URL, harness.baseUrl);
        assert.equal(env.AGENTRAIL_API_KEY, undefined);
        assert.ok(env.AGENTRAIL_RUN_REPORT_PATH, "AGENTRAIL_RUN_REPORT_PATH must be defined");
        await writeFile(logPath, "blocked by missing token\n", "utf8");
        await writeFile(env.AGENTRAIL_RUN_REPORT_PATH, `${JSON.stringify({
          version: 1,
          runId: env.AGENTRAIL_RUN_ID,
          status: "blocked",
          summary: "Missing GitHub token; user needs to reconnect GitHub.",
          reason: "missing_github_token",
          actionRequired: "Reconnect GitHub.",
          resumeInstructions: "Retry the task after GitHub is reconnected.",
        })}\n`, "utf8");
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
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "missing_github_token");
  assert.equal(storedTask?.blocker?.actionRequired, "Reconnect GitHub.");
  assert.equal(storedTask?.blocker?.resumeInstructions, "Retry the task after GitHub is reconnected.");
  const blockerEvents = harness.eventStore.events.filter((event) => {
    return event.type === "task.updated"
      && Array.isArray(event.data.changedFields)
      && event.data.changedFields.includes("blocker");
  });
  assert.equal(blockerEvents.length, 1);

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.userAction?.reason, "missing_github_token");
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
          reason: "missing_github_token",
          actionRequired: "Reconnect GitHub.",
          resumeInstructions: "Retry the task after GitHub is reconnected.",
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
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "missing_github_token");
  assert.equal(storedTask?.blocker?.actionRequired, "Reconnect GitHub.");
  assert.equal(storedTask?.blocker?.resumeInstructions, "Retry the task after GitHub is reconnected.");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.reports[0].status, "blocked");
  assert.equal(run.userAction?.resumeInstructions, "Retry the task after GitHub is reconnected.");
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
          reason: "missing_github_token",
          actionRequired: "Reconnect GitHub.",
          resumeInstructions: "Retry the task after GitHub is reconnected.",
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
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "missing_github_token");
  assert.equal(storedTask?.blocker?.actionRequired, "Reconnect GitHub.");
  assert.equal(storedTask?.blocker?.resumeInstructions, "Retry the task after GitHub is reconnected.");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
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
  const task = harness.taskQueue.createTask({
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
  assert.equal(run.userAction?.reason, "runner_execution_failed");

  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "runner_execution_failed");
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
  const task = harness.taskQueue.createTask({
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
  assert.equal(run.userAction?.reason, "runner_execution_failed");

  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "runner_execution_failed");
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
          resumeInstructions: "Run the task again after installing the validator.",
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
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.reason, "missing_tool");
  assert.equal(storedTask?.blocker?.actionRequired, "Install the required local validator.");
  assert.equal(storedTask?.blocker?.resumeInstructions, "Run the task again after installing the validator.");

  const runStore = new AgentRunStore({
    storagePath: path.join(homePath, "stores", "agent-runs.json"),
  });
  const [run] = runStore.listRuns();
  assert.ok(run);
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.summary, "Could not validate the task.");
});

test("agent run blocks Cursor in strict mode when runner policy cannot be enforced", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-cursor-manual-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousPath = process.env.PATH;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await harness.close();
  });

  const binPath = path.join(homePath, "bin");
  await mkdir(binPath, { recursive: true });
  const cursorExecutable = process.platform === "win32" ? "cursor.cmd" : "cursor";
  const cursorPath = path.join(binPath, cursorExecutable);
  await writeFile(
    cursorPath,
    process.platform === "win32" ? "@echo off\r\nexit /B 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  await chmod(cursorPath, 0o755);
  const resolverExecutable = process.platform === "win32" ? "where.cmd" : "which";
  const resolverPath = path.join(binPath, resolverExecutable);
  await writeFile(
    resolverPath,
    process.platform === "win32"
      ? "@echo off\r\nif \"%1\"==\"cursor\" exit /B 0\r\nexit /B 1\r\n"
      : "#!/bin/sh\n[ \"$1\" = \"cursor\" ] && exit 0\nexit 1\n",
    "utf8",
  );
  await chmod(resolverPath, 0o755);
  process.env.PATH = binPath;

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false);
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-CURSOR-MANUAL",
    title: "Continue in Cursor",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "cursor",
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
      publishBranch: async () => {
        throw new Error("publish should not run when Cursor policy is rejected");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.deepEqual(storedTask?.availableActions, ["resolve_blocker"]);
  assert.equal(storedTask?.blocker?.kind, "awaiting_user");
  assert.equal(storedTask?.blocker?.sourceAgentId, "agt_runner");
  assert.equal(storedTask?.blocker?.reason, "runner_policy_not_enforced");
  assert.match(storedTask?.blocker?.actionRequired ?? "", /external sandbox|advisory mode/i);

  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.userAction?.kind, "awaiting_user");
  assert.equal(run.userAction?.taskId, task.id);
  assert.equal(run.userAction?.reason, "runner_policy_not_enforced");
  assert.match(run.summary ?? "", /Runner policy cannot be enforced for cursor/);
});

test("agent run blocks before launching Codex when denied read files are present", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-denied-preflight-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
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
    identifier: "AGEA-RUN-DENIED-PREFLIGHT",
    title: "Do not expose denied files",
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
        await writeFile(path.join(worktreePath, ".env"), "SECRET=value\n", "utf8");
      },
      launchRunner: async () => {
        throw new Error("launchRunner should not be called when policy preflight fails");
      },
      publishBranch: async () => {
        throw new Error("publish should not run when policy preflight fails");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.equal(storedTask?.blocker?.reason, "runner_policy_denied_files_present");
  assert.match(storedTask?.blocker?.actionRequired ?? "", /\.env/);

  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.userAction?.reason, "runner_policy_denied_files_present");
  assert.match(run.summary ?? "", /\.env/);
});

test("agent run blocks after Codex creates denied write files", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-denied-postrun-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
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
    identifier: "AGEA-RUN-DENIED-POSTRUN",
    title: "Do not write denied files",
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
      launchRunner: async ({ logPath, worktreePath }) => {
        await writeFile(logPath, "created denied file\n", "utf8");
        await writeFile(path.join(worktreePath, ".env"), "SECRET=value\n", "utf8");
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Runner wrote a denied file.",
        };
      },
      publishBranch: async () => {
        throw new Error("publish should not run when policy post-run validation fails");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.equal(storedTask?.blocker?.reason, "runner_policy_violation");
  assert.match(storedTask?.blocker?.actionRequired ?? "", /created \.env/);

  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  const [run] = runStore.listRuns();
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.userAction?.reason, "runner_policy_violation");
  assert.match(run.summary ?? "", /created \.env/);
});

test("agent run uses Cursor external sandbox wrappers instead of GUI fallback", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-cursor-wrapper-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({ agentRunStorePath });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousPath = process.env.PATH;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await harness.close();
  });

  const binPath = path.join(homePath, "bin");
  await mkdir(binPath, { recursive: true });
  const resolverExecutable = process.platform === "win32" ? "where.cmd" : "which";
  const resolverPath = path.join(binPath, resolverExecutable);
  await writeFile(
    resolverPath,
    process.platform === "win32" ? "@echo off\r\nexit /B 1\r\n" : "#!/bin/sh\nexit 1\n",
    "utf8",
  );
  await chmod(resolverPath, 0o755);
  process.env.PATH = `${binPath}${path.delimiter}${previousPath ?? ""}`;

  const wrapperPath = path.join(binPath, "agentrail-cursor-wrapper");
  await writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' '{\"version\":1,\"runId\":\"'\"$AGENTRAIL_RUN_ID\"'\",\"status\":\"blocked\",\"summary\":\"External sandbox wrapper ran.\",\"reason\":\"external_wrapper_ran\",\"actionRequired\":\"Review wrapper output.\",\"resumeInstructions\":\"Resolve the wrapper blocker.\"}' > \"$AGENTRAIL_RUN_REPORT_PATH\"",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o755);

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, false, {
    runnerPolicy: {
      preset: "external_sandbox",
      externalSandbox: {
        command: [wrapperPath],
      },
    },
  });
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-CURSOR-WRAPPER",
    title: "Run Cursor through external sandbox",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  await writeAgentEnv(homePath, {
    AGENTRAIL_BASE_URL: harness.baseUrl,
    AGENTRAIL_API_KEY: harness.apiKey,
    AGENTRAIL_AGENT_ID: "agt_runner",
    AGENTRAIL_AGENT_RUNNER: "cursor",
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
      publishBranch: async () => {
        throw new Error("publish should not run for wrapper blocker");
      },
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  const storedTask = harness.taskQueue.getRawTask(task.id);
  assert.equal(storedTask?.status, "blocked");
  assert.equal(storedTask?.blocker?.reason, "external_wrapper_ran");

  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  const [run] = runStore.listRuns();
  assert.equal(run.launch.executable, wrapperPath);
  assert.equal(run.status, "awaiting_user");
  assert.equal(run.userAction?.reason, "external_wrapper_ran");
});

test("agent run starts a resolved task with a historical awaiting_user run", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-run-resolved-blocker-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const agentRunStorePath = path.join(homePath, "stores", "agent-runs.json");
  const harness = await createHarness({
    agentRunStorePath,
    submitTask: async (taskId, payload) => {
      const pullRequest = readPullRequestPayload(payload);
      return {
        data: {
          taskId,
          submissionId: "sub_resolved_blocker_test",
          prUrl: "https://github.com/oxnw/agentrail/pull/456",
          prNumber: 456,
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
  const task = harness.taskQueue.createTask({
    identifier: "AGEA-RUN-RESOLVED-BLOCKER",
    title: "Continue after user resolved blocker",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    status: "todo",
    availableActions: ["start"],
  });
  const historicalRunStore = new AgentRunStore({ storagePath: agentRunStorePath });
  historicalRunStore.createRun({
    runId: "run_historical_blocker",
    agentId: "agt_runner",
    runner: "codex",
    taskId: task.id,
    taskIdentifier: task.identifier,
    status: "awaiting_user",
    repoPath: repoRoot,
    worktreePath: path.join(homePath, "worktrees", "agt_runner", "run_historical_blocker"),
    branchName: `agentrail/agt_runner/${task.id}`,
    promptPath: null,
    logPath: null,
    handoffPath: null,
    createdAt: "2026-05-09T12:00:00.000Z",
    startedAt: "2026-05-09T12:00:01.000Z",
    finishedAt: "2026-05-09T12:01:00.000Z",
    updatedAt: "2026-05-09T12:01:00.000Z",
    exitCode: 0,
    summary: "Waiting for user action that has since been resolved.",
    launch: {
      executable: "codex",
      args: ["exec"],
    },
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
        await writeFile(logPath, "resolved blocker run\n", "utf8");
        await writeFile(path.join(worktreePath, "README.md"), "resolved blocker continued\n", "utf8");
        const commitSha = commitAll(worktreePath, "resolved blocker change");
        await writeAgentRailHandoff(handoffPath, {
          target: "agentrail",
          summary: "Resolved blocker task completed.",
          commitSha,
        });
        return {
          status: "succeeded",
          exitCode: 0,
          summary: "Resolved blocker task completed.",
        };
      },
      publishBranch: async () => {},
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(harness.taskQueue.getRawTask(task.id)?.status, "in_review");
  const runStore = new AgentRunStore({ storagePath: agentRunStorePath });
  assert.equal(runStore.listRuns({ status: "awaiting_user" }).length, 1);
  assert.equal(runStore.listRuns({ status: "succeeded" }).length, 1);
});

test("run current and run actions read managed run context from a local snapshot", async (t) => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-run-context-cli-"));
  const contextPath = path.join(homePath, "context.json");
  const restoreEnv = captureRunContextEnv();
  const context = {
    data: {
      run: {
        runId: "run_cli",
        agentId: "agt_runner",
        runner: "codex",
        taskId: "tsk_cli",
        taskIdentifier: "AGEA-CLI",
        status: "running",
        worktreePath: "/tmp/agentrail/run_cli",
        branchName: "agentrail/agt_runner/tsk_cli",
      },
      task: {
        id: "tsk_cli",
        identifier: "AGEA-CLI",
        title: "Show current run",
        status: "in_progress",
        availableActions: ["submit"],
        acceptanceCriteria: [],
      },
      nextActions: [
        {
          id: "submit",
          label: "Finish the code change, commit locally, write the handoff file, then report completion.",
        },
      ],
    },
    availableActions: ["submit"],
  };

  t.after(async () => {
    restoreEnv();
    await rm(homePath, { recursive: true, force: true });
  });

  await writeFile(contextPath, `${JSON.stringify(context)}\n`, "utf8");
  process.env.AGENTRAIL_RUN_ID = "run_cli";
  process.env.AGENTRAIL_RUN_CONTEXT_PATH = contextPath;
  delete process.env.AGENTRAIL_BASE_URL;
  delete process.env.AGENTRAIL_RUN_CONTEXT_TOKEN;

  const currentStdout = createMemoryWriter();
  const currentStderr = createMemoryWriter();
  const currentExitCode = await runCli(["run", "current"], {
    cwd: homePath,
    stdout: currentStdout,
    stderr: currentStderr,
  });
  assert.equal(currentExitCode, 0, currentStderr.toString());
  assert.match(currentStdout.toString(), /Run: run_cli/);
  assert.match(currentStdout.toString(), /Task: AGEA-CLI Show current run/);
  assert.match(currentStdout.toString(), /Available actions: submit/);

  const actionsStdout = createMemoryWriter();
  const actionsStderr = createMemoryWriter();
  const actionsExitCode = await runCli(["run", "actions", "--json"], {
    cwd: homePath,
    stdout: actionsStdout,
    stderr: actionsStderr,
  });
  assert.equal(actionsExitCode, 0, actionsStderr.toString());
  assert.deepEqual(JSON.parse(actionsStdout.toString()).availableActions, ["submit"]);
});

test("run current prefers live run context when a context token is available", async (t) => {
  const restoreEnv = captureRunContextEnv();
  t.after(() => {
    restoreEnv();
  });

  process.env.AGENTRAIL_RUN_ID = "run_live";
  process.env.AGENTRAIL_BASE_URL = "http://127.0.0.1:31337";
  process.env.AGENTRAIL_RUN_CONTEXT_TOKEN = "arrun_live_context_token_123456789";
  delete process.env.AGENTRAIL_RUN_CONTEXT_PATH;

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["run", "current", "--json"], {
    cwd: process.cwd(),
    stdout,
    stderr,
    runContextFetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assert.equal(url.pathname, "/agent-runs/run_live/context");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer arrun_live_context_token_123456789");
      return new Response(JSON.stringify({
        data: {
          run: {
            runId: "run_live",
            agentId: "agt_runner",
            runner: "codex",
            taskId: "tsk_live",
            taskIdentifier: "AGEA-LIVE",
            status: "running",
            worktreePath: "/tmp/live",
            branchName: "agentrail/agt_runner/tsk_live",
          },
          task: {
            id: "tsk_live",
            identifier: "AGEA-LIVE",
            title: "Live context",
            status: "in_progress",
            availableActions: ["submit"],
            acceptanceCriteria: [],
          },
          nextActions: [
            {
              id: "submit",
              label: "Finish the code change, commit locally, write the handoff file, then report completion.",
            },
          ],
        },
        availableActions: ["submit"],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(JSON.parse(stdout.toString()).data.run.runId, "run_live");
});

test("run current reports missing managed run context", async (t) => {
  const restoreEnv = captureRunContextEnv();
  t.after(() => {
    restoreEnv();
  });
  delete process.env.AGENTRAIL_RUN_ID;
  delete process.env.AGENTRAIL_BASE_URL;
  delete process.env.AGENTRAIL_RUN_CONTEXT_TOKEN;
  delete process.env.AGENTRAIL_RUN_CONTEXT_PATH;

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["run", "current"], {
    cwd: process.cwd(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /requires AGENTRAIL_RUN_ID/);
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
    status: "awaiting_user",
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
    userAction: null,
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
  assert.equal(body.data[0].status, "awaiting_user");
});

function captureRunContextEnv(): () => void {
  const keys = [
    "AGENTRAIL_RUN_ID",
    "AGENTRAIL_BASE_URL",
    "AGENTRAIL_RUN_CONTEXT_PATH",
    "AGENTRAIL_RUN_CONTEXT_TOKEN",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

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
    scopes: ["tasks:read", "tasks:write", "events:read"],
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
    eventStore,
    taskQueue,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function writeSetupRepo(
  repoRoot: string,
  homePath: string,
  baseUrl: string,
  markdownExport: boolean,
  options?: { runnerPolicy?: Parameters<typeof createSetupConfig>[0]["runnerPolicy"] },
) {
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
    runnerPolicy: options?.runnerPolicy,
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

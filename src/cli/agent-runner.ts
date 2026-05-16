import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { AgentRunStore, createRunContextToken, hashRunContextToken, type AgentRunRecord, type AgentRunReportInput, type AgentRunStatus } from "../agent-run-store.ts";
import { parseSimpleEnv } from "../env-file.ts";
import { buildManagedRunContextEnvelope } from "../managed-run-context.ts";
import {
  currentAgentEnvPathForHome,
  managedAgentEnvPathForHome,
  primaryRepoFromConfig,
  readSetupConfigFromHome,
  resolveAgentRailHome,
  type ConnectedRepo,
  type SetupConfigLike,
} from "./agentrail-home.ts";
import { withTemporaryLocalServer } from "./local-bootstrap.ts";
import type { SetupConfig } from "./setup-config.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

interface AgentEnvValues {
  AGENTRAIL_BASE_URL?: string;
  AGENTRAIL_API_KEY?: string;
  AGENTRAIL_AGENT_ID?: string;
  AGENTRAIL_AGENT_RUNNER?: string;
  AGENTRAIL_AGENT_MODEL?: string;
  AGENTRAIL_RUN_ID?: string;
  AGENTRAIL_MAX_CONCURRENT_TASKS?: string;
  AGENTRAIL_REPO_ALLOWLIST?: string;
  AGENTRAIL_AGENT_RECIPE_PATH?: string;
  AGENTRAIL_HANDOFF_PATH?: string;
  AGENTRAIL_RUN_REPORT_PATH?: string;
  AGENTRAIL_RUN_CONTEXT_PATH?: string;
  AGENTRAIL_RUN_CONTEXT_TOKEN?: string;
  AGENTRAIL_RUNNER_TIMEOUT_SECONDS?: string;
}

export interface AgentRunnerHooks {
  fetch?: typeof globalThis.fetch;
  launchRunner?: (params: LaunchRunnerParams) => Promise<LaunchRunnerResult>;
  publishBranch?: (params: PublishBranchParams) => Promise<void>;
  prepareWorktree?: (params: PrepareWorktreeParams) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface RunAgentRunnerOptions extends AgentRunnerHooks {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}

interface AgentRunFlags {
  help?: boolean;
  envFile?: string;
  agentId?: string;
  once?: boolean;
  pollIntervalSeconds: number;
  maxRuns?: number;
  worktreeRoot?: string;
  json?: boolean;
}

interface AgentStatusFlags {
  help?: boolean;
  agentId?: string;
  json?: boolean;
}

interface AgentReportFlags {
  help?: boolean;
  runId?: string;
  status?: "progress" | "blocked" | "completed";
  summary?: string;
  reason?: string;
  actionRequired?: string;
  resumeInstructions?: string;
  handoffFile?: string;
  json?: boolean;
}

interface LaunchRunnerParams {
  runner: string;
  model: string | null;
  repoPath: string;
  worktreePath: string;
  prompt: string;
  promptPath: string;
  recipePath: string | null;
  logPath: string;
  handoffPath: string | null;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

interface LaunchRunnerResult {
  status: AgentRunStatus;
  exitCode: number | null;
  summary: string | null;
}

interface PublishBranchParams {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  commitSha: string;
}

interface PrepareWorktreeParams {
  repoPath: string;
  worktreePath: string;
  branchName: string;
}

interface TaskSummary {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority?: string;
  availableActions: string[];
}

interface TaskDetail {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status: string;
  updatedAt?: string;
  submissionId?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  acceptanceCriteria?: string[];
  context?: {
    project?: string | null;
    goal?: string | null;
  } | null;
  availableActions: string[];
}

type RunnerHandoff =
  | {
      version: 1;
      target: "agentrail";
      summary: string;
      commitSha: string;
      checks: unknown[];
      artifacts: unknown[];
      pullRequest: Record<string, unknown> | null;
    }
  | {
      version: 1;
      target: "user";
      summary: string;
      reason: string;
      actionRequired: string;
      resumeInstructions: string;
    };

interface JsonEnvelope<T> {
  data: T;
  availableActions?: string[];
  meta?: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 15;
const DEFAULT_RUNNER_TIMEOUT_MS = 60 * 60 * 1000;
const RUNNER_KILL_GRACE_MS = 5_000;

export async function runAgentRun(argv: string[], options: RunAgentRunnerOptions): Promise<number> {
  const flags = parseAgentRunArgs(argv);
  if (flags.help) {
    options.stdout.write(renderAgentRunUsage());
    return 0;
  }

  const homePath = resolveAgentRailHome({ cwd: options.cwd, explicitHome: null });
  const setupConfig = await readSetupConfigFromHome(homePath);
  const envState = await readAgentEnvFile({
    cwd: options.cwd,
    homePath,
    explicitEnvFile: flags.envFile,
    agentId: flags.agentId,
  });

  const rawBaseUrl = envState.values.AGENTRAIL_BASE_URL ?? setupConfig?.server?.baseUrl ?? null;
  if (!rawBaseUrl) {
    options.stderr.write("agentrail agent run requires AGENTRAIL_BASE_URL in the agent env file or setup config.\n");
    return 1;
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  const execute = async (effectiveBaseUrl: string) => executeAgentRun({
    ...options,
    flags,
    homePath,
    setupConfig,
    envState,
    baseUrl: effectiveBaseUrl,
  });

  if (isTemporaryLocalRunnerConfig(setupConfig) && sameServerBaseUrl(baseUrl, setupConfig.server.baseUrl)) {
    return await withTemporaryLocalServer({
      homePath,
      config: setupConfig,
      handler: ({ baseUrl: temporaryBaseUrl }) => execute(temporaryBaseUrl),
    });
  }

  return await execute(baseUrl);
}

export async function runAgentStatus(argv: string[], options: Pick<RunAgentRunnerOptions, "cwd" | "stdout" | "stderr">): Promise<number> {
  const flags = parseAgentStatusArgs(argv);
  if (flags.help) {
    options.stdout.write(renderAgentStatusUsage());
    return 0;
  }

  const homePath = resolveAgentRailHome({ cwd: options.cwd, explicitHome: null });
  const setupConfig = await readSetupConfigFromHome(homePath);
  const store = createAgentRunStore(homePath, setupConfig);
  const runs = store.listRuns({
    agentId: flags.agentId,
    limit: 20,
  });

  if (flags.json) {
    options.stdout.write(`${JSON.stringify({ data: runs }, null, 2)}\n`);
    return 0;
  }

  if (runs.length === 0) {
    options.stdout.write("No agent runs recorded.\n");
    return 0;
  }

  for (const run of runs) {
    options.stdout.write(`${run.runId} ${run.status} ${run.runner} ${run.taskIdentifier} ${run.worktreePath}\n`);
    if (run.summary) {
      options.stdout.write(`  summary: ${run.summary}\n`);
    }
    if (run.handoffPath) {
      options.stdout.write(`  handoff: ${run.handoffPath}\n`);
    }
  }
  return 0;
}

export async function runAgentReport(argv: string[], options: Pick<RunAgentRunnerOptions, "cwd" | "stdout" | "stderr" | "fetch">): Promise<number> {
  const flags = parseAgentReportArgs(argv);
  if (flags.help) {
    options.stdout.write(renderAgentReportUsage());
    return 0;
  }

  const envValues = process.env as AgentEnvValues;
  const rawBaseUrl = envValues.AGENTRAIL_BASE_URL ?? null;
  const apiKey = envValues.AGENTRAIL_API_KEY ?? null;
  const runId = flags.runId ?? envValues.AGENTRAIL_RUN_ID ?? null;
  const reportPath = envValues.AGENTRAIL_RUN_REPORT_PATH ?? null;
  const status = flags.status ?? null;
  const summary = flags.summary ?? null;
  if (!runId) {
    options.stderr.write("agentrail agent report requires AGENTRAIL_RUN_ID in the runner environment.\n");
    return 1;
  }
  if (!status) {
    options.stderr.write("agentrail agent report requires --status progress|blocked|completed.\n");
    return 1;
  }
  if (!summary || summary.trim().length === 0) {
    options.stderr.write("agentrail agent report requires --summary.\n");
    return 1;
  }
  const blockedMetadata = status === "blocked"
    ? validateBlockedReportFlags(flags, options.stderr)
    : null;
  if (blockedMetadata === false) {
    return 1;
  }

  const handoffFile = flags.handoffFile ?? (status === "completed" ? envValues.AGENTRAIL_HANDOFF_PATH : undefined);
  const handoffResult = await readReportHandoffFile({
    cwd: options.cwd,
    handoffFile,
    stderr: options.stderr,
  });
  if (!handoffResult.ok) {
    return 1;
  }
  const handoff = handoffResult.value;

  if (reportPath) {
    await writeLocalRunReport({
      cwd: options.cwd,
      reportPath,
      runId,
      status,
      summary,
      blockedMetadata,
      handoff,
    });
    if (flags.json) {
      options.stdout.write(`${JSON.stringify({
        data: { runId, status },
        availableActions: [],
      })}\n`);
      return 0;
    }
    options.stdout.write(`Recorded local ${status} report for ${runId}.\n`);
    return 0;
  }

  if (!rawBaseUrl || !apiKey) {
    options.stderr.write("agentrail agent report requires AGENTRAIL_BASE_URL and AGENTRAIL_API_KEY, or AGENTRAIL_RUN_REPORT_PATH, in the runner environment.\n");
    return 1;
  }

  const response = await fetchJson<JsonEnvelope<{ runId: string }>>({
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    route: `/agent-runs/${runId}/report`,
    apiKey,
    fetchImpl: options.fetch ?? globalThis.fetch,
    method: "POST",
    body: {
      status,
      summary,
      ...(blockedMetadata ? blockedMetadata : {}),
      ...(handoff !== undefined ? { handoff } : {}),
    },
  });

  if (flags.json) {
    options.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }

  options.stdout.write(`Reported ${status} for ${response.data.runId}.\n`);
  return 0;
}

async function readReportHandoffFile({
  cwd,
  handoffFile,
  stderr,
}: {
  cwd: string;
  handoffFile: string | undefined;
  stderr: Writer;
}): Promise<{ ok: true; value: unknown | undefined } | { ok: false }> {
  if (!handoffFile) {
    return { ok: true, value: undefined };
  }

  const resolvedPath = path.resolve(cwd, handoffFile);
  try {
    return { ok: true, value: JSON.parse(await readFile(resolvedPath, "utf8")) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Failed to read handoff file at ${resolvedPath}: ${message}\n`);
    return { ok: false };
  }
}

async function writeLocalRunReport({
  cwd,
  reportPath,
  runId,
  status,
  summary,
  blockedMetadata,
  handoff,
}: {
  cwd: string;
  reportPath: string;
  runId: string;
  status: "progress" | "blocked" | "completed";
  summary: string;
  blockedMetadata: BlockedReportMetadata | null;
  handoff: unknown;
}): Promise<void> {
  const resolvedReportPath = path.resolve(cwd, reportPath);
  await mkdir(path.dirname(resolvedReportPath), { recursive: true });
  await appendFile(
    resolvedReportPath,
    `${JSON.stringify({
      version: 1,
      runId,
      status,
      summary,
      ...(blockedMetadata ? blockedMetadata : {}),
      ...(handoff !== undefined ? { handoff } : {}),
    })}\n`,
    "utf8",
  );
}

async function executeAgentRun({
  cwd,
  stdout,
  stderr,
  flags,
  homePath,
  setupConfig,
  envState,
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
  launchRunner = defaultLaunchRunner,
  publishBranch = defaultPublishBranch,
  prepareWorktree = defaultPrepareWorktree,
  sleep = defaultSleep,
  now = () => new Date(),
}: RunAgentRunnerOptions & {
  flags: AgentRunFlags;
  homePath: string;
  setupConfig: SetupConfigLike | null;
  envState: { path: string | null; values: AgentEnvValues };
  baseUrl: string;
}): Promise<number> {
  const agentId = flags.agentId ?? envState.values.AGENTRAIL_AGENT_ID ?? null;
  const apiKey = envState.values.AGENTRAIL_API_KEY ?? null;
  const runner = envState.values.AGENTRAIL_AGENT_RUNNER ?? "codex";
  const model = normalizeOptionalModel(envState.values.AGENTRAIL_AGENT_MODEL);
  const maxRuns = flags.once ? 1 : flags.maxRuns;
  if (!agentId || !apiKey) {
    stderr.write("agentrail agent run requires AGENTRAIL_AGENT_ID and AGENTRAIL_API_KEY in the agent env file.\n");
    return 1;
  }

  const repo = resolveRepoForAgent({
    cwd,
    setupConfig,
    repoAllowlist: parseCsv(envState.values.AGENTRAIL_REPO_ALLOWLIST),
  });
  const worktreeRoot = path.resolve(flags.worktreeRoot ?? path.join(homePath, "worktrees", agentId));
  const runStore = createAgentRunStore(homePath, setupConfig);
  const runCapacity = Math.max(1, Number.parseInt(envState.values.AGENTRAIL_MAX_CONCURRENT_TASKS ?? "1", 10) || 1);
  const runnerTimeoutMs = parseRunnerTimeoutMs(envState.values.AGENTRAIL_RUNNER_TIMEOUT_SECONDS);
  let totalRuns = 0;
  let hadFailure = false;
  do {
    if (maxRuns !== undefined && totalRuns >= maxRuns) {
      return hadFailure ? 1 : 0;
    }
    const activeRuns = runStore.countActiveRuns(agentId);
    const openSlots = Math.max(0, runCapacity - activeRuns);
    if (openSlots === 0) {
      if (flags.once) {
        writeRunSummary(stdout, flags.json, { status: "idle", reason: "capacity_reached", agentId, activeRuns });
        return 0;
      }
      await sleep(flags.pollIntervalSeconds * 1000);
      continue;
    }

    const availableRunSlots = maxRuns === undefined
      ? openSlots
      : Math.min(openSlots, Math.max(0, maxRuns - totalRuns));
    const nextTasks = await selectRunnableTasks({
      baseUrl,
      apiKey,
      fetchImpl,
      agentId,
      runStore,
      limit: availableRunSlots,
    });

    if (nextTasks.length === 0) {
      if (flags.once) {
        writeRunSummary(stdout, flags.json, { status: "idle", reason: "no_tasks", agentId, activeRuns });
        return 0;
      }
      await waitForTaskEvent({
        baseUrl,
        apiKey,
        fetchImpl,
        timeoutMs: flags.pollIntervalSeconds * 1000,
      });
      continue;
    }

    for (const task of nextTasks) {
      let run: AgentRunRecord | null = null;
      try {
        const startedTask = task.status === "todo"
          ? await startTask({ baseUrl, apiKey, fetchImpl, taskId: task.id })
          : await getTaskDetail({ baseUrl, apiKey, fetchImpl, taskId: task.id });
        run = await executeSingleTaskRun({
          agentId,
          runner,
          model,
          repo,
          worktreeRoot,
          homePath,
          now,
          task: startedTask,
          runStore,
          prepareWorktree,
          launchRunner,
          publishBranch,
          markdownEnabled: Boolean(setupConfig?.exports?.markdown?.enabled),
          baseUrl,
          apiKey,
          fetchImpl,
          runnerTimeoutMs,
        });
      } catch (error) {
        hadFailure = true;
        totalRuns += 1;
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`${message}\n`);
        writeRunSummary(stdout, flags.json, {
          status: "failed",
          taskId: task.id,
          taskIdentifier: task.identifier,
          error: message,
        });
        if (maxRuns !== undefined && maxRuns <= totalRuns) {
          return 1;
        }
        continue;
      }
      totalRuns += 1;
      if (run.status === "failed") {
        hadFailure = true;
      }
      writeRunSummary(stdout, flags.json, {
        status: run.status,
        runId: run.runId,
        taskId: run.taskId,
        taskIdentifier: run.taskIdentifier,
        worktreePath: run.worktreePath,
      });
      if (maxRuns !== undefined && maxRuns <= totalRuns) {
        return hadFailure ? 1 : 0;
      }
    }

    if (flags.once) {
      return hadFailure ? 1 : 0;
    }
  } while (true);
}

async function executeSingleTaskRun({
  agentId,
  runner,
  model,
  repo,
  worktreeRoot,
  homePath,
  now,
  task,
  runStore,
  prepareWorktree,
  launchRunner,
  publishBranch,
  markdownEnabled,
  baseUrl,
  apiKey,
  fetchImpl,
  runnerTimeoutMs,
}: {
  agentId: string;
  runner: string;
  model: string | null;
  repo: ConnectedRepo;
  worktreeRoot: string;
  homePath: string;
  now: () => Date;
  task: TaskDetail;
  runStore: AgentRunStore;
  prepareWorktree: (params: PrepareWorktreeParams) => Promise<void>;
  launchRunner: (params: LaunchRunnerParams) => Promise<LaunchRunnerResult>;
  publishBranch: (params: PublishBranchParams) => Promise<void>;
  markdownEnabled: boolean;
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  runnerTimeoutMs: number;
}): Promise<AgentRunRecord> {
  const timestamp = now().toISOString();
  const runId = `run_${crypto.randomBytes(6).toString("hex")}`;
  const branchName = buildBranchName(agentId, task.id);
  const runDir = path.join(homePath, "runs", runId);
  const worktreePath = path.join(worktreeRoot, runId);
  const promptPath = path.join(runDir, "prompt.md");
  const logPath = path.join(runDir, "runner.log");
  const handoffPath = path.join(runDir, "handoff.json");
  const managedRecipePath = path.join(runDir, "agent-recipes.md");
  const reportPath = path.join(runDir, "reports.jsonl");
  const contextPath = path.join(runDir, "context.json");
  const runContextToken = createRunContextToken();
  const prompt = buildPrompt({ task, repo, recipePath: managedRecipePath, branchName, handoffPath, contextPath });

  await mkdir(runDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(managedRecipePath, renderManagedAgentRecipe(), { encoding: "utf8" });
  await writeFile(promptPath, prompt, { encoding: "utf8" });

  const initialRun = runStore.createRun({
    runId,
    agentId,
    runner,
    taskId: task.id,
    taskIdentifier: task.identifier,
    status: "starting",
    repoPath: repo.path,
    worktreePath,
    branchName,
    promptPath,
    logPath,
    handoffPath,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
    exitCode: null,
    summary: null,
    runContextTokenHash: hashRunContextToken(runContextToken),
    runContextTokenIssuedAt: timestamp,
    launch: defaultLaunchMetadata(runner, model, worktreePath, managedRecipePath, runDir),
  });

  if (markdownEnabled) {
    await writeRunMarkdown({ homePath, run: initialRun });
  }

  try {
    await prepareWorktree({
      repoPath: repo.path,
      worktreePath,
      branchName,
    });

    const running = runStore.updateRun(runId, {
      status: "running",
      startedAt: now().toISOString(),
    });
    if (!running) {
      throw new Error(`Agent run ${runId} disappeared before launch.`);
    }
    await writeManagedRunContextSnapshot({
      contextPath,
      run: running,
      task,
    });

    const result = await launchRunner({
      runner,
      model,
      repoPath: repo.path,
      worktreePath,
      prompt,
      promptPath,
      recipePath: managedRecipePath,
      logPath,
      handoffPath,
      timeoutMs: runnerTimeoutMs,
      env: buildManagedRunnerEnv({
        baseEnv: process.env,
        values: {
          AGENTRAIL_AGENT_ID: agentId,
          AGENTRAIL_RUN_ID: runId,
          AGENTRAIL_BASE_URL: baseUrl,
          AGENTRAIL_RUN_CONTEXT_TOKEN: runContextToken,
          AGENTRAIL_RUN_CONTEXT_PATH: contextPath,
          AGENTRAIL_AGENT_RUNNER: runner,
          ...(model ? { AGENTRAIL_AGENT_MODEL: model } : {}),
          AGENTRAIL_AGENT_RECIPE_PATH: managedRecipePath,
          AGENTRAIL_HOME: homePath,
          AGENTRAIL_TASK_ID: task.id,
          AGENTRAIL_TASK_IDENTIFIER: task.identifier,
          AGENTRAIL_HANDOFF_PATH: handoffPath,
          AGENTRAIL_RUN_REPORT_PATH: reportPath,
        },
      }),
    });
    const finalResult = await processRunnerHandoff({
      task,
      result,
      repo,
      agentId,
      runId,
      runDir,
      handoffPath,
      worktreePath,
      branchName,
      baseUrl,
      apiKey,
      fetchImpl,
      publishBranch,
      runStore,
      reportPath,
    });
    const completed = runStore.updateRun(runId, {
      status: finalResult.status,
      exitCode: finalResult.exitCode,
      summary: finalResult.summary,
      finishedAt: ["failed", "succeeded", "cancelled", "awaiting_user"].includes(finalResult.status) ? now().toISOString() : null,
    });
    if (!completed) {
      throw new Error(`Agent run ${runId} disappeared after launch.`);
    }

    if (markdownEnabled) {
      await writeRunMarkdown({ homePath, run: completed });
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = runStore.updateRun(runId, {
      status: "failed",
      exitCode: 1,
      summary: message,
      finishedAt: now().toISOString(),
    });
    if (failed && markdownEnabled) {
      await writeRunMarkdown({ homePath, run: failed });
    }
    throw error;
  }
}

async function writeManagedRunContextSnapshot({
  contextPath,
  run,
  task,
}: {
  contextPath: string;
  run: AgentRunRecord;
  task: TaskDetail;
}): Promise<void> {
  await writeFile(contextPath, `${JSON.stringify(buildManagedRunContextEnvelope({ run, taskBody: task }), null, 2)}\n`, "utf8");
}

function buildManagedRunnerEnv({
  baseEnv,
  values,
}: {
  baseEnv: NodeJS.ProcessEnv;
  values: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
  };
  delete env.AGENTRAIL_BASE_URL;
  delete env.AGENTRAIL_API_KEY;
  delete env.AGENTRAIL_API_KEY_ID;
  delete env.AGENTRAIL_ADMIN_API_KEY;
  delete env.AGENTRAIL_OPERATOR_API_KEY;
  delete env.AGENTRAIL_OPERATOR_KEY;
  delete env.AGENTRAIL_OPERATOR_KEY_ID;
  delete env.AGENTRAIL_SETUP_API_KEY;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_WEBHOOK_SECRET;
  delete env.CIRCLECI_TOKEN;
  delete env.CIRCLECI_WEBHOOK_SECRET;
  delete env.LINEAR_API_KEY;
  delete env.LINEAR_WEBHOOK_SECRET;
  return {
    ...env,
    ...values,
  };
}

async function processRunnerHandoff({
  task,
  result,
  repo,
  agentId,
  runId,
  runDir,
  handoffPath,
  worktreePath,
  branchName,
  baseUrl,
  apiKey,
  fetchImpl,
  publishBranch,
  runStore,
  reportPath,
}: {
  task: TaskDetail;
  result: LaunchRunnerResult;
  repo: ConnectedRepo;
  agentId: string;
  runId: string;
  runDir: string;
  handoffPath: string;
  worktreePath: string;
  branchName: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  publishBranch: (params: PublishBranchParams) => Promise<void>;
  runStore: AgentRunStore;
  reportPath: string;
}): Promise<LaunchRunnerResult> {
  await consumeLocalRunReports({ reportPath, runId, runStore });
  const reportedRun = runStore.getRun(runId);
  const latestReport = reportedRun?.reports[reportedRun.reports.length - 1] ?? null;
  if (!reportedRun?.reportedHandoff && latestReport?.status === "blocked") {
    const blocker = blockedMetadataFromRun(reportedRun, latestReport.summary);
    await blockTaskAwaitingUser({
      baseUrl,
      apiKey,
      fetchImpl,
      taskId: task.id,
      runId,
      agentId,
      blocker,
    });
    return {
      status: "awaiting_user",
      exitCode: result.exitCode,
      summary: latestReport.summary,
    };
  }

  if (reportedRun?.reportedHandoff) {
    const reportedHandoff = await readRunnerHandoff({
      handoffPath,
      worktreePath,
      reportedHandoff: reportedRun.reportedHandoff,
    });
    if (reportedHandoff.target === "user") {
      await blockTaskAwaitingUser({
        baseUrl,
        apiKey,
        fetchImpl,
        taskId: task.id,
        runId,
        agentId,
        blocker: {
          reason: reportedHandoff.reason,
          actionRequired: reportedHandoff.actionRequired,
          resumeInstructions: reportedHandoff.resumeInstructions,
        },
      });
      return {
        status: "awaiting_user",
        exitCode: result.exitCode,
        summary: reportedHandoff.summary,
      };
    }
    if (result.status !== "succeeded") {
      return result;
    }
    return await publishAgentRailHandoff({
      task,
      result,
      repo,
      runId,
      runDir,
      handoffPath,
      worktreePath,
      branchName,
      baseUrl,
      apiKey,
      fetchImpl,
      publishBranch,
      handoff: reportedHandoff,
    });
  }

  if (result.status === "awaiting_user") {
    const summary = result.summary ?? "Runner is waiting for manual continuation.";
    const blocker = {
      reason: "manual_runner_continuation",
      actionRequired: "Continue the task in the external runner.",
      resumeInstructions: "After the manual work is complete, report completion or resolve the blocker to start a fresh run.",
    };
    const updated = runStore.reportRun(runId, {
      status: "blocked",
      summary,
      ...blocker,
    });
    if (!updated) {
      throw new Error(`Agent run ${runId} disappeared while recording manual continuation.`);
    }
    await blockTaskAwaitingUser({
      baseUrl,
      apiKey,
      fetchImpl,
      taskId: task.id,
      runId,
      agentId,
      blocker,
    });
    return {
      status: "awaiting_user",
      exitCode: result.exitCode,
      summary,
    };
  }

  if (result.status !== "succeeded") {
    return result;
  }

  const handoff = await readRunnerHandoff({
    handoffPath,
    worktreePath,
    reportedHandoff: null,
  });
  if (handoff.target === "user") {
    await blockTaskAwaitingUser({
      baseUrl,
      apiKey,
      fetchImpl,
      taskId: task.id,
      runId,
      agentId,
      blocker: {
        reason: handoff.reason,
        actionRequired: handoff.actionRequired,
        resumeInstructions: handoff.resumeInstructions,
      },
    });
    return {
      status: "awaiting_user",
      exitCode: result.exitCode,
      summary: handoff.summary,
    };
  }

  return await publishAgentRailHandoff({
    task,
    result,
    repo,
    runId,
    runDir,
    handoffPath,
    worktreePath,
    branchName,
    baseUrl,
    apiKey,
    fetchImpl,
    publishBranch,
    handoff,
  });
}

async function publishAgentRailHandoff({
  task,
  result,
  repo,
  runId,
  runDir,
  handoffPath,
  worktreePath,
  branchName,
  baseUrl,
  apiKey,
  fetchImpl,
  publishBranch,
  handoff,
}: {
  task: TaskDetail;
  result: LaunchRunnerResult;
  repo: ConnectedRepo;
  runId: string;
  runDir: string;
  handoffPath: string;
  worktreePath: string;
  branchName: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  publishBranch: (params: PublishBranchParams) => Promise<void>;
  handoff: Extract<RunnerHandoff, { target: "agentrail" }>;
}): Promise<LaunchRunnerResult> {
  await publishBranch({
    repoPath: repo.path,
    worktreePath,
    branchName,
    commitSha: handoff.commitSha,
  });

  const pullRequest = {
    head: branchName,
    base: repo.defaultBranch ?? "main",
    title: task.title,
    body: handoff.summary,
    headSha: handoff.commitSha,
    ...(handoff.pullRequest ?? {}),
  };
  await submitTask({
    baseUrl,
    apiKey,
    fetchImpl,
    taskId: task.id,
    payload: {
      summary: handoff.summary,
      checks: handoff.checks,
      artifacts: handoff.artifacts,
      notes: `Submitted by AgentRail run ${runId}. Handoff: ${path.relative(runDir, handoffPath)}`,
      pullRequest,
    },
    idempotencyKey: `agent-run:${runId}:submit`,
  });

  const latestTask = await getTaskDetail({ baseUrl, apiKey, fetchImpl, taskId: task.id });
  if (taskShowsMeaningfulProgress(task, latestTask)) {
    return {
      ...result,
      summary: result.summary ?? `Submitted ${task.identifier} through AgentRail.`,
    };
  }

  return {
    status: "failed",
    exitCode: result.exitCode,
    summary: "AgentRail consumed the handoff but task state did not progress to a submitted or reviewable state.",
  };
}

async function consumeLocalRunReports({
  reportPath,
  runId,
  runStore,
}: {
  reportPath: string;
  runId: string;
  runStore: AgentRunStore;
}): Promise<void> {
  const content = await readOptionalTextFile(reportPath);
  if (!content.trim()) return;

  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Runner report file ${reportPath} contains invalid JSON on line ${index + 1}: ${message}`);
    }
    const report = validateLocalRunReport(parsed, runId, index + 1);
    const updated = runStore.reportRun(runId, report);
    if (!updated) {
      throw new Error(`Agent run ${runId} disappeared while consuming local reports.`);
    }
  }
}

async function readOptionalTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

function validateLocalRunReport(
  value: unknown,
  expectedRunId: string,
  lineNumber: number,
): AgentRunReportInput {
  if (!isRecord(value)) {
    throw new Error(`Runner report line ${lineNumber} must be a JSON object.`);
  }
  if (value.version !== 1) {
    throw new Error(`Runner report line ${lineNumber} version must be 1.`);
  }
  if (value.runId !== expectedRunId) {
    throw new Error(`Runner report line ${lineNumber} runId must be ${expectedRunId}.`);
  }
  const status = value.status;
  if (status !== "progress" && status !== "blocked" && status !== "completed") {
    throw new Error(`Runner report line ${lineNumber} status must be progress, blocked, or completed.`);
  }
  const summary = requiredReportString(value.summary, lineNumber, "summary");
  const blockedMetadata = status === "blocked"
    ? {
      reason: requiredReportString(value.reason, lineNumber, "reason"),
      actionRequired: requiredReportString(value.actionRequired, lineNumber, "actionRequired"),
      resumeInstructions: requiredReportString(value.resumeInstructions, lineNumber, "resumeInstructions"),
    }
    : null;
  const handoff = value.handoff;
  let normalizedHandoff: Record<string, unknown> | null | undefined;
  if (handoff === undefined) {
    normalizedHandoff = undefined;
  } else if (handoff === null) {
    normalizedHandoff = null;
  } else if (isRecord(handoff)) {
    normalizedHandoff = handoff;
  } else {
    throw new Error(`Runner report line ${lineNumber} handoff must be an object or null.`);
  }
  const report: AgentRunReportInput = status === "blocked"
    ? {
      status,
      summary,
      reason: blockedMetadata.reason,
      actionRequired: blockedMetadata.actionRequired,
      resumeInstructions: blockedMetadata.resumeInstructions,
      ...(normalizedHandoff !== undefined ? { handoff: normalizedHandoff } : {}),
    }
    : {
      status,
      summary,
      ...(normalizedHandoff !== undefined ? { handoff: normalizedHandoff } : {}),
    };
  return report;
}

function requiredReportString(value: unknown, lineNumber: number, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Runner report line ${lineNumber} field \`${fieldName}\` must be a non-empty string.`);
  }
  return value;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readRunnerHandoff({
  handoffPath,
  worktreePath,
  reportedHandoff,
}: {
  handoffPath: string;
  worktreePath: string;
  reportedHandoff: Record<string, unknown> | null;
}): Promise<RunnerHandoff> {
  if (reportedHandoff) {
    return await validateRunnerHandoff(reportedHandoff, worktreePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(handoffPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Runner did not write a valid handoff file at ${handoffPath}: ${message}`);
  }
  return await validateRunnerHandoff(parsed, worktreePath);
}

async function validateRunnerHandoff(value: unknown, worktreePath: string): Promise<RunnerHandoff> {
  if (!isRecord(value)) {
    throw new Error("Runner handoff must be a JSON object.");
  }
  if (value.version !== 1) {
    throw new Error("Runner handoff version must be 1.");
  }
  if (value.target === "user") {
    return {
      version: 1,
      target: "user",
      summary: requiredString(value.summary, "summary"),
      reason: requiredString(value.reason, "reason"),
      actionRequired: requiredString(value.actionRequired, "actionRequired"),
      resumeInstructions: requiredString(value.resumeInstructions, "resumeInstructions"),
    };
  }
  if (value.target === "agentrail") {
    const commitSha = requiredString(value.commitSha, "commitSha");
    await assertCommitReachable(worktreePath, commitSha);
    return {
      version: 1,
      target: "agentrail",
      summary: requiredString(value.summary, "summary"),
      commitSha,
      checks: Array.isArray(value.checks) ? value.checks : [],
      artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
      pullRequest: isRecord(value.pullRequest) ? value.pullRequest : null,
    };
  }
  throw new Error("Runner handoff target must be `agentrail` or `user`.");
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Runner handoff field \`${fieldName}\` must be a non-empty string.`);
  }
  return value;
}

async function assertCommitReachable(worktreePath: string, commitSha: string): Promise<void> {
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("git", ["-C", worktreePath, "merge-base", "--is-ancestor", commitSha, "HEAD"], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`Runner handoff commit ${commitSha} is not reachable from the task worktree HEAD.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskShowsMeaningfulProgress(initialTask: TaskDetail, latestTask: TaskDetail): boolean {
  if (latestTask.status === "in_review" || latestTask.status === "done" || latestTask.status === "cancelled") {
    return true;
  }
  if (latestTask.submissionId || latestTask.prUrl || typeof latestTask.prNumber === "number") {
    return true;
  }
  if (latestTask.availableActions.some((action) => ["ship", "view_ci_status", "view_review_feedback"].includes(action))) {
    return true;
  }
  return latestTask.status !== initialTask.status && latestTask.status !== "in_progress";
}

function isSetupVerificationTask(identifier: string): boolean {
  return identifier.startsWith("LOCAL-SETUP-");
}

async function selectRunnableTasks({
  baseUrl,
  apiKey,
  fetchImpl,
  agentId,
  runStore,
  limit,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  agentId: string;
  runStore: AgentRunStore;
  limit: number;
}): Promise<TaskSummary[]> {
  const [inProgress, todo, inReview] = await Promise.all([
    listMyTasks({ baseUrl, apiKey, fetchImpl, status: "in_progress" }),
    listMyTasks({ baseUrl, apiKey, fetchImpl, status: "todo" }),
    listMyTasks({ baseUrl, apiKey, fetchImpl, status: "in_review" }),
  ]);
  const candidates = [...inProgress, ...todo, ...inReview]
    .filter((task) => !isSetupVerificationTask(task.identifier))
    .filter((task) => !runStore.findActiveRunByTask(agentId, task.id))
    .filter((task) => task.status === "in_progress"
      || task.availableActions.includes("start")
      || (task.status === "in_review" && task.availableActions.includes("submit")));
  return candidates.slice(0, limit);
}

async function waitForTaskEvent({
  baseUrl,
  apiKey,
  fetchImpl,
  timeoutMs,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<void> {
  const url = new URL("task-events/stream", `${baseUrl}/`);
  url.searchParams.set("eventTypes", "task.updated,task.ci_failed,task.ci_recovered,task.review_changes_requested,task.awaiting_user");
  url.searchParams.set("heartbeatSeconds", "15");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text.trim().length > 0
        ? `Task event stream failed with HTTP ${response.status}: ${text.slice(0, 200).trim()}`
        : `Task event stream failed with HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("Task event stream did not include a readable response body.");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        if (sseFrameHasData(frame)) {
          return;
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

function sseFrameHasData(frame: string): boolean {
  return frame.split(/\r?\n/u).some((line) => line.startsWith("data:"));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function listMyTasks({
  baseUrl,
  apiKey,
  fetchImpl,
  status,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  status: string;
}): Promise<TaskSummary[]> {
  const response = await fetchJson<JsonEnvelope<TaskSummary[]>>({
    baseUrl,
    route: `/tasks/mine?status=${encodeURIComponent(status)}&limit=100`,
    apiKey,
    fetchImpl,
  });
  return response.data ?? [];
}

async function getTaskDetail({
  baseUrl,
  apiKey,
  fetchImpl,
  taskId,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  taskId: string;
}): Promise<TaskDetail> {
  const response = await fetchJson<JsonEnvelope<TaskDetail>>({
    baseUrl,
    route: `/tasks/${taskId}`,
    apiKey,
    fetchImpl,
  });
  return response.data;
}

async function startTask({
  baseUrl,
  apiKey,
  fetchImpl,
  taskId,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  taskId: string;
}): Promise<TaskDetail> {
  const response = await fetchJson<JsonEnvelope<TaskDetail>>({
    baseUrl,
    route: `/tasks/${taskId}/start`,
    apiKey,
    fetchImpl,
    method: "POST",
    body: {},
    idempotencyKey: `agent-run-start:${taskId}`,
  });
  return response.data;
}

async function submitTask({
  baseUrl,
  apiKey,
  fetchImpl,
  taskId,
  payload,
  idempotencyKey,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  taskId: string;
  payload: unknown;
  idempotencyKey: string;
}): Promise<unknown> {
  return await fetchJson<JsonEnvelope<unknown>>({
    baseUrl,
    route: `/tasks/${taskId}/submit`,
    apiKey,
    fetchImpl,
    method: "POST",
    body: payload,
    idempotencyKey,
  });
}

interface BlockedReportMetadata {
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
}

function validateBlockedReportFlags(flags: AgentReportFlags, stderr: Writer): BlockedReportMetadata | false {
  const missing = [
    ["--reason", flags.reason],
    ["--action-required", flags.actionRequired],
    ["--resume-instructions", flags.resumeInstructions],
  ].filter(([, value]) => typeof value !== "string" || value.trim().length === 0).map(([flag]) => flag);
  if (missing.length > 0) {
    stderr.write(`agentrail agent report --status blocked requires ${missing.join(", ")}.\n`);
    return false;
  }
  return {
    reason: flags.reason!.trim(),
    actionRequired: flags.actionRequired!.trim(),
    resumeInstructions: flags.resumeInstructions!.trim(),
  };
}

function blockedMetadataFromRun(run: AgentRunRecord, summary: string): BlockedReportMetadata {
  if (run.userAction) {
    return {
      reason: run.userAction.reason,
      actionRequired: run.userAction.actionRequired,
      resumeInstructions: run.userAction.resumeInstructions,
    };
  }
  throw new Error(`Blocked report for run ${run.runId} is missing structured user-action metadata: ${summary}`);
}

async function blockTaskAwaitingUser({
  baseUrl,
  apiKey,
  fetchImpl,
  taskId,
  runId,
  agentId,
  blocker,
}: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  taskId: string;
  runId: string;
  agentId: string;
  blocker: BlockedReportMetadata;
}): Promise<unknown> {
  return await fetchJson<JsonEnvelope<unknown>>({
    baseUrl,
    route: `/tasks/${taskId}/blocker`,
    apiKey,
    fetchImpl,
    method: "POST",
    body: {
      sourceRunId: runId,
      sourceAgentId: agentId,
      reason: blocker.reason,
      actionRequired: blocker.actionRequired,
      resumeInstructions: blocker.resumeInstructions,
    },
    idempotencyKey: `agent-run-blocker:${runId}`,
  });
}

async function fetchJson<T>({
  baseUrl,
  route,
  apiKey,
  fetchImpl,
  method = "GET",
  body,
  idempotencyKey,
}: {
  baseUrl: string;
  route: string;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<T> {
  const response = await fetchImpl(new URL(route.replace(/^\//u, ""), `${baseUrl}/`), {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const shouldParseJson = Boolean(text) && (response.ok || contentType.includes("application/json"));
  let json: unknown = null;
  if (shouldParseJson) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      if (response.ok) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON response from ${route}: ${message}`);
      }
    }
  }
  if (!response.ok) {
    const message = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string"
      ? json.error.message
      : text.trim().length > 0
        ? `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200).trim()}`
        : `HTTP ${response.status} ${response.statusText}`.trim();
    throw new Error(message);
  }
  if (json === null) {
    throw new Error(`Empty response from ${route}.`);
  }
  return json as T;
}

function createAgentRunStore(homePath: string, setupConfig: SetupConfigLike | null): AgentRunStore {
  const relativePath = setupConfig?.persistence?.agentRunStorePath ?? "stores/agent-runs.json";
  return new AgentRunStore({
    storagePath: path.resolve(homePath, relativePath),
  });
}

function parseRunnerTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_RUNNER_TIMEOUT_MS;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_RUNNER_TIMEOUT_MS;
  }
  return seconds * 1000;
}

function resolveRepoForAgent({
  cwd,
  setupConfig,
  repoAllowlist,
}: {
  cwd: string;
  setupConfig: SetupConfigLike | null;
  repoAllowlist: string[];
}): ConnectedRepo {
  const repos = setupConfig?.repos ?? [];
  for (const slug of repoAllowlist) {
    const match = repos.find((repo) => repo.slug === slug);
    if (match) {
      return match;
    }
  }
  return primaryRepoFromConfig(setupConfig) ?? {
    path: cwd,
    slug: repoAllowlist[0] ?? "local/repo",
    defaultBranch: "main",
  };
}

function renderManagedAgentRecipe(): string {
  return [
    "# AgentRail Managed Agent Instructions",
    "",
    "This file is generated for one AgentRail-managed run.",
    "AgentRail owns task assignment, lifecycle state, provider status, pull request creation, shipping, and rollback.",
    "Your job is limited to repository work inside the provided git worktree and reporting the result.",
    "",
    "## Required Flow",
    "",
    "1. Work only inside the provided git worktree for this task.",
    "2. Use only run-scoped AgentRail commands from the child process: `agentrail run current`, `agentrail run actions`, and `agentrail agent report`.",
    "3. Do not hand-roll AgentRail API calls, query broad task lifecycle endpoints, push branches, create pull requests, ship, or roll back directly.",
    "4. Report meaningful progress with `agentrail agent report --status progress --summary \"short update\"`.",
    "5. If blocked, report the blocker with `agentrail agent report --status blocked --summary \"what user action is needed\" --reason \"short reason\" --action-required \"what the user must do\" --resume-instructions \"how to continue after the user acts\"`.",
    "6. For any blocker, also write a `target: \"user\"` handoff file at `$AGENTRAIL_HANDOFF_PATH` so AgentRail can recover if the report command fails.",
    "7. Run the smallest relevant validation before reporting completion.",
    "8. Commit locally when the task requires a code change.",
    "9. Write the structured handoff JSON file at `$AGENTRAIL_HANDOFF_PATH` before exiting.",
    "10. Report completion with `agentrail agent report --status completed --summary \"short completion summary\" --handoff-file \"$AGENTRAIL_HANDOFF_PATH\"`.",
    "11. Use `target: \"agentrail\"` when AgentRail should publish and continue the lifecycle.",
    "12. Use `target: \"user\"` when missing credentials, provider failures, sandbox restrictions, tooling, or validation failures require user intervention.",
    "",
    "## Run-Scoped AgentRail Commands",
    "",
    "- `agentrail run current` re-reads only this run's assigned task and current action.",
    "- `agentrail run actions` shows only the allowed next AgentRail actions for this run.",
    "- `agentrail agent report` reports progress, blockers, or completion for this run.",
    "",
    "## Handoff Contract",
    "",
    "- For `target: \"agentrail\"`, write JSON with `version`, `target`, `summary`, `commitSha`, and optional `checks`, `artifacts`, and `pullRequest`.",
    "- For `target: \"user\"`, write JSON with `version`, `target`, `summary`, `reason`, `actionRequired`, and `resumeInstructions`.",
    "- Do not edit `AGENTS.md`, `CLAUDE.md`, `.agentrail/*`, or other instruction files unless the task explicitly asks for that change.",
    "- Do not expose secrets in logs, prompts, commits, or final summaries.",
    "",
  ].join("\n");
}

function buildPrompt({
  task,
  repo,
  recipePath,
  branchName,
  handoffPath,
  contextPath,
}: {
  task: TaskDetail;
  repo: ConnectedRepo;
  recipePath: string;
  branchName: string;
  handoffPath: string;
  contextPath: string;
}): string {
  return [
    `You are working on AgentRail task ${task.identifier}.`,
    ``,
    `Repo: ${repo.slug}`,
    `Branch: ${branchName}`,
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    `Recipe file: ${recipePath}`,
    `Handoff file: ${handoffPath}`,
    `Run context file: ${contextPath}`,
    `Available AgentRail actions: ${task.availableActions.join(", ") || "none"}`,
    ``,
    `Goal: ${task.context?.goal ?? task.description ?? task.title}`,
    task.description ? `Description:\n${task.description}` : "",
    Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : "",
    ``,
    `Use the recipe file as your standing instructions.`,
    `Work only inside the provided git worktree.`,
    `Do not edit AGENTS.md, CLAUDE.md, AgentRail recipe files, or other instruction/config files unless the task explicitly requires it.`,
    `AgentRail commands available to you: agentrail run current, agentrail run actions, and agentrail agent report.`,
    `Use agentrail run current or agentrail run actions only if you need to re-read this run's assignment or allowed next actions.`,
    `Do not hand-roll AgentRail API calls, push branches, or create pull requests directly; use the run-scoped AgentRail commands instead.`,
    `Report meaningful progress with: agentrail agent report --status progress --summary "short update".`,
    `If blocked by missing credentials, provider access, sandbox limits, or validation failures, report: agentrail agent report --status blocked --summary "what user action is needed" --reason "short reason" --action-required "what the user must do" --resume-instructions "how to continue after the user acts".`,
    `For any blocker, also write a target "user" handoff file; if the report command fails, the handoff file is AgentRail's recovery path.`,
    `When the work is ready, commit locally and write the handoff JSON file at the handoff path.`,
    `After writing the handoff file, report completion with: agentrail agent report --status completed --summary "short completion summary" --handoff-file "$AGENTRAIL_HANDOFF_PATH".`,
    `Use target "agentrail" when AgentRail should publish the commit, or target "user" when user action is required.`,
    `AgentRail handoff shape: {"version":1,"target":"agentrail","summary":"...","commitSha":"...","checks":[],"artifacts":[]}.`,
    `User handoff shape: {"version":1,"target":"user","summary":"...","reason":"...","actionRequired":"...","resumeInstructions":"..."}.`,
    `Do not expose secrets in output.`,
  ].filter(Boolean).join("\n");
}

function buildBranchName(agentId: string, taskId: string): string {
  const sanitizedAgentId = agentId.replace(/[^A-Za-z0-9/_-]+/gu, "_");
  const sanitizedTaskId = taskId.replace(/[^A-Za-z0-9/_-]+/gu, "_");
  return `agentrail/${sanitizedAgentId}/${sanitizedTaskId}`;
}

function defaultLaunchMetadata(runner: string, model: string | null, worktreePath: string, recipePath: string, runDir: string) {
  if (runner === "claude-code") {
    const args = ["--print", "--output-format", "stream-json"];
    if (model) args.push("--model", model);
    args.push("--append-system-prompt-file", recipePath);
    return {
      executable: "claude",
      args,
    };
  }
  if (runner === "cursor") {
    return {
      executable: "cursor",
      args: [worktreePath],
    };
  }
  return {
    executable: "codex",
    args: codexLaunchArgs(worktreePath, runDir, model),
  };
}

function codexLaunchArgs(worktreePath: string, runDir: string, model: string | null = null): string[] {
  return [
    "-a",
    "never",
    "-c",
    "shell_environment_policy.inherit=all",
    "exec",
    "--sandbox",
    "workspace-write",
    "--ignore-user-config",
    "--cd",
    worktreePath,
    "--add-dir",
    runDir,
    ...(model ? ["--model", model] : []),
    "--json",
    "-",
  ];
}

async function defaultPublishBranch({ worktreePath, branchName, commitSha }: PublishBranchParams): Promise<void> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("git", ["-C", worktreePath, "push", "origin", `${commitSha}:refs/heads/${branchName}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    throw new Error(stderr || stdout || `Failed to push ${branchName}.`);
  }
}

async function defaultPrepareWorktree({ repoPath, worktreePath, branchName }: PrepareWorktreeParams): Promise<void> {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const branchExists = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", branchName], {
    stdio: "ignore",
  }).status === 0;
  const args = branchExists
    ? ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "HEAD"]
    : ["-C", repoPath, "worktree", "add", "-b", branchName, worktreePath, "HEAD"];
  const result = spawnSync("git", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `Failed to create git worktree at ${worktreePath}.`);
  }
}

async function defaultLaunchRunner(params: LaunchRunnerParams): Promise<LaunchRunnerResult> {
  if (params.runner === "cursor") {
    const hasCursorAgent = commandExists("cursor-agent");
    if (!hasCursorAgent) {
      if (!commandExists("cursor")) {
        return {
          status: "failed",
          exitCode: null,
          summary: "Cursor CLI is not installed; install cursor-agent or cursor to continue this task.",
        };
      }
      const child = spawn("cursor", [params.worktreePath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // The run is already marked waiting for manual continuation; avoid an unhandled child error.
      });
      child.unref();
      return {
        status: "awaiting_user",
        exitCode: null,
        summary: "Opened Cursor for manual continuation.",
      };
    }
    return await runChildProcess({
      executable: "cursor-agent",
      args: [params.worktreePath],
      prompt: params.prompt,
      cwd: params.worktreePath,
      logPath: params.logPath,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
  }

  if (params.runner === "claude-code") {
    const args = ["--print", "--output-format", "stream-json"];
    if (params.model) {
      args.push("--model", params.model);
    }
    if (params.recipePath) {
      args.push("--append-system-prompt-file", params.recipePath);
    }
    return await runChildProcess({
      executable: "claude",
      args,
      prompt: params.prompt,
      cwd: params.worktreePath,
      logPath: params.logPath,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
  }

  return await runChildProcess({
    executable: "codex",
    args: codexLaunchArgs(params.worktreePath, path.dirname(params.handoffPath ?? params.logPath), params.model),
    prompt: params.prompt,
    cwd: params.worktreePath,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
}

function commandExists(command: string): boolean {
  const executable = process.platform === "win32" ? "where" : "which";
  return spawnSync(executable, [command], { stdio: "ignore" }).status === 0;
}

async function runChildProcess({
  executable,
  args,
  prompt,
  cwd,
  logPath,
  timeoutMs,
  env,
}: {
  executable: string;
  args: string[];
  prompt: string;
  cwd: string;
  logPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchRunnerResult> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise<LaunchRunnerResult>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: "pipe",
    });
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, RUNNER_KILL_GRACE_MS);
    }, timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      cleanup();
      const summary = timedOut
        ? "Runner timed out."
        : code === 0
          ? "Runner completed successfully."
          : `Runner exited with code ${code}.`;
      writeFile(logPath, Buffer.concat([
        Buffer.from("## stdout\n"),
        Buffer.concat(stdoutChunks),
        Buffer.from("\n## stderr\n"),
        Buffer.concat(stderrChunks),
        Buffer.from(`\n## runner\n${summary}\n`),
      ]))
        .then(() => {
          resolve({
            status: timedOut ? "failed" : code === 0 ? "succeeded" : "failed",
            exitCode: timedOut ? null : code,
            summary,
          });
        })
        .catch(reject);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function writeRunMarkdown({
  homePath,
  run,
}: {
  homePath: string;
  run: AgentRunRecord;
}): Promise<void> {
  const notePath = path.join(homePath, "notes", "runs", `${run.runId}.md`);
  await mkdir(path.dirname(notePath), { recursive: true });
  const lines = [
    `# ${run.runId}`,
    ``,
    `- Agent: ${run.agentId}`,
    `- Runner: ${run.runner}`,
    `- Task: ${run.taskIdentifier}`,
    `- Status: ${run.status}`,
    `- Worktree: ${run.worktreePath}`,
    `- Branch: ${run.branchName ?? "detached"}`,
    `- Created: ${run.createdAt}`,
    `- Started: ${run.startedAt ?? "not started"}`,
    `- Finished: ${run.finishedAt ?? "not finished"}`,
    `- Exit code: ${run.exitCode ?? "n/a"}`,
    run.summary ? `- Summary: ${run.summary}` : null,
    run.handoffPath ? `- Handoff: ${run.handoffPath}` : null,
  ].filter(Boolean);
  await writeFile(notePath, `${lines.join("\n")}\n`, "utf8");
}

async function readAgentEnvFile({
  cwd,
  homePath,
  explicitEnvFile,
  agentId,
}: {
  cwd: string;
  homePath: string;
  explicitEnvFile?: string;
  agentId?: string;
}): Promise<{ path: string | null; values: AgentEnvValues }> {
  const candidates = [
    explicitEnvFile ? path.resolve(cwd, explicitEnvFile) : null,
    agentId ? managedAgentEnvPathForHome(homePath, agentId) : null,
    currentAgentEnvPathForHome(homePath),
  ].filter((value): value is string => Boolean(value));

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      return {
        path: filePath,
        values: parseSimpleEnv(content) as AgentEnvValues,
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
      continue;
    }
  }

  return { path: null, values: {} };
}

function parseAgentRunArgs(argv: string[]): AgentRunFlags {
  const flags: AgentRunFlags = {
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--env-file":
        flags.envFile = nextValue(argv, ++index, arg);
        break;
      case "--agent-id":
        flags.agentId = nextValue(argv, ++index, arg);
        break;
      case "--once":
        flags.once = true;
        break;
      case "--poll-interval":
        flags.pollIntervalSeconds = parsePositiveInteger(nextValue(argv, ++index, arg), arg);
        break;
      case "--max-runs":
        flags.maxRuns = parsePositiveInteger(nextValue(argv, ++index, arg), arg);
        break;
      case "--worktree-root":
        flags.worktreeRoot = nextValue(argv, ++index, arg);
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

function parseAgentStatusArgs(argv: string[]): AgentStatusFlags {
  const flags: AgentStatusFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--agent-id":
        flags.agentId = nextValue(argv, ++index, arg);
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

function parseAgentReportArgs(argv: string[]): AgentReportFlags {
  const flags: AgentReportFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
        flags.help = true;
        break;
      case "--run-id":
        flags.runId = nextValue(argv, ++index, arg);
        break;
      case "--status": {
        const value = nextValue(argv, ++index, arg);
        if (value !== "progress" && value !== "blocked" && value !== "completed") {
          throw new Error("--status must be progress, blocked, or completed.");
        }
        flags.status = value;
        break;
      }
      case "--summary":
        flags.summary = nextValue(argv, ++index, arg);
        break;
      case "--reason":
        flags.reason = nextValue(argv, ++index, arg);
        break;
      case "--action-required":
        flags.actionRequired = nextValue(argv, ++index, arg);
        break;
      case "--resume-instructions":
        flags.resumeInstructions = nextValue(argv, ++index, arg);
        break;
      case "--handoff-file":
        flags.handoffFile = nextValue(argv, ++index, arg);
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}".`);
    }
  }
  return flags;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeOptionalModel(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function writeRunSummary(output: Writer, json: boolean | undefined, body: Record<string, unknown>) {
  if (json) {
    output.write(`${JSON.stringify(body)}\n`);
    return;
  }
  if (body.status === "idle") {
    output.write(`No runnable tasks: ${String(body.reason)}.\n`);
    return;
  }
  if (body.status === "failed" && body.error) {
    output.write(`Run failed for ${String(body.taskIdentifier)}: ${String(body.error)}.\n`);
    return;
  }
  output.write(`Run ${String(body.runId)} ${String(body.status)} for ${String(body.taskIdentifier)} in ${String(body.worktreePath)}.\n`);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  const hasScheme = /^https?:\/\//iu.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  const parsed = new URL(candidate);
  if (!hasScheme && !isLocalImplicitHttpHost(parsed.hostname)) {
    throw new Error("AgentRail base URL must include http:// or https:// for non-local hosts.");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function isLocalImplicitHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.") || host.endsWith(".local");
}

function sameServerBaseUrl(left: string, right: string): boolean {
  return normalizeBaseUrl(left) === normalizeBaseUrl(right);
}

function isTemporaryLocalRunnerConfig(config: SetupConfigLike | null): config is SetupConfig {
  if (!config || typeof config !== "object") {
    return false;
  }
  const candidate = config as Partial<SetupConfig>;
  return candidate.persistence?.kind === "file"
    && typeof candidate.server?.baseUrl === "string"
    && candidate.server.baseUrl.length > 0;
}

function renderAgentRunUsage(): string {
  return [
    "Usage:",
    "  agentrail agent run [flags]",
    "",
    "Flags:",
    "  --env-file <path>",
    "  --agent-id <agt_...>",
    "  --once",
    "  --poll-interval <seconds>",
    "  --max-runs <n>",
    "  --worktree-root <path>",
    "  --json",
    "",
  ].join("\n");
}

function renderAgentStatusUsage(): string {
  return [
    "Usage:",
    "  agentrail agent status [flags]",
    "",
    "Flags:",
    "  --agent-id <agt_...>",
    "  --json",
    "",
  ].join("\n");
}

function renderAgentReportUsage(): string {
  return [
    "Usage:",
    "  agentrail agent report --status <progress|blocked|completed> --summary <text> [flags]",
    "",
    "Flags:",
    "  --run-id <run_...>        Defaults to AGENTRAIL_RUN_ID.",
    "  --reason <text>           Required with --status blocked.",
    "  --action-required <text>  Required with --status blocked.",
    "  --resume-instructions <text>",
    "                            Required with --status blocked.",
    "  --handoff-file <path>     Include a handoff JSON payload.",
    "  --json",
    "",
  ].join("\n");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

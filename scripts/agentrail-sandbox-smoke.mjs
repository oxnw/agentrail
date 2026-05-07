#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? "live";

  if (mode !== "live") {
    throw new Error(`Unsupported mode "${mode}". Use --mode live.`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-sandbox-smoke-"));

  try {
    const report = await runLiveSmoke(tempDir);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runLiveSmoke(tempDir) {
  const {
    owner,
    repo,
    issueNumber,
    pullNumber,
    headBranch,
    baseBranch,
    allowShip,
    expectedHeadSha
  } = await resolveLiveConfig({ env: process.env });

  const missing = ["GITHUB_TOKEN"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Live sandbox smoke is missing required env vars: ${missing.join(", ")}`);
  }

  const taskId = process.env.AGENTRAIL_SANDBOX_TASK_ID ?? "tsk_LIVESANDBOX01";
  const agentId = process.env.AGENTRAIL_SANDBOX_AGENT_ID ?? "agt_sandbox_agent";
  const port = resolvePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const taskStorePath = path.join(tempDir, "tasks.json");
  const taskSource = {
    provider: "github",
    owner,
    repo,
    issueNumber,
    pullNumber,
    branch: headBranch,
    baseBranch,
    ...(expectedHeadSha
      ? { headSha: expectedHeadSha }
      : {}),
  };

  await writeFile(taskStorePath, JSON.stringify({
    tasks: [buildLiveTaskRecord({ taskId, agentId, owner, repo, issueNumber })],
    idempotencyEntries: [],
  }, null, 2));

  const server = startServer({
    scriptName: "start",
    env: {
      AGENTRAIL_MODE: "server",
      AGENTRAIL_HOST: "127.0.0.1",
      AGENTRAIL_PORT: String(port),
      AGENTRAIL_PUBLIC_BASE_URL: baseUrl,
      AGENTRAIL_TASK_STORE_PATH: taskStorePath,
      AGENTRAIL_TASK_SOURCES: JSON.stringify({ [taskId]: taskSource }),
    },
  });

  try {
    await waitForHealth({ baseUrl, server });
    const apiKey = await bootstrapLiveApiKey({ baseUrl, agentId });
    const { AgentRailClient } = await loadTypescriptSdk();
    const client = new AgentRailClient({
      baseUrl,
      apiKey,
      retry: { maxAttempts: 1 },
    });

    const steps = [];
    await client.getTask(taskId);
    steps.push("get_task");

    await client.submitTask(
      taskId,
      {
        summary: "AgentRail live sandbox smoke submission.",
        mode: "adapter_managed",
        pullRequest: {
          title: `AgentRail live sandbox smoke for issue #${issueNumber}`,
          head: headBranch,
          base: baseBranch,
          draft: true,
        },
      },
      `sandbox-live-submit-${issueNumber}`,
    );
    steps.push("submit");

    const ci = await client.getTaskCiStatus(taskId);
    steps.push("read_ci_status");

    const review = await client.getTaskReviewFeedback(taskId);
    steps.push("read_review_feedback");

    let ship = null;
    if (allowShip) {
      ship = await client.shipTask(
        taskId,
        {
          mode: "merge_only",
          targetEnvironment: "staging",
          prNumber: pullNumber,
          ...(expectedHeadSha
            ? { expectedHeadSha }
            : {}),
        },
        `sandbox-live-ship-${issueNumber}`,
      );
      steps.push("ship");
    } else {
      steps.push("ship_skipped_requires_AGENTRAIL_SANDBOX_ALLOW_SHIP");
    }

    return {
      mode: "live",
      entrypoint: "npm start",
      sdk: "sdk/typescript/dist/index.js",
      baseUrl,
      sandbox: `${owner}/${repo}`,
      taskId,
      issueNumber,
      pullNumber,
      steps,
      result: {
        ciStatus: ci.data.overallStatus,
        reviewOutcome: review.data.latestDecision.outcome,
        shipStatus: ship?.data?.status ?? "not_run",
      },
    };
  } finally {
    await stopServer(server);
  }
}

function buildLiveTaskRecord({ taskId, agentId, owner, repo, issueNumber }) {
  const now = new Date().toISOString();
  return {
    id: taskId,
    identifier: `github:${owner}/${repo}:issues/${issueNumber}`,
    title: `Live sandbox validation #${issueNumber}`,
    description: "AgentRail live-provider sandbox validation task.",
    status: "in_progress",
    priority: "high",
    assignee: { id: agentId, name: "AgentRail Sandbox Agent" },
    acceptanceCriteria: [
      "Submit through AgentRail.",
      "Read CI through AgentRail.",
      "Read review feedback through AgentRail.",
      "Ship only when explicitly allowed for a disposable sandbox PR.",
    ],
    links: { issue: `https://github.com/${owner}/${repo}/issues/${issueNumber}` },
    context: {
      project: `${owner}/${repo}`,
      goal: "Live AgentRail sandbox validation",
    },
    updatedAt: now,
    availableActions: ["submit", "view_ci_status", "view_review_feedback", "ship"],
    submissions: [],
    latestSubmissionId: null,
    ciStatus: null,
    reviewOutcome: null,
    shipOperation: null,
    rollbackOperation: null,
    dueAt: null,
    createdAt: now,
    version: 1,
    source: { provider: "github", owner, repo, issueNumber },
  };
}

export async function resolveLiveConfig({ env = process.env } = {}) {
  const scenarioConfig = await resolveScenarioEnv({ env });
  const owner = env.AGENTRAIL_SANDBOX_OWNER ?? scenarioConfig.owner ?? "oxnw";
  const repo = env.AGENTRAIL_SANDBOX_REPO ?? scenarioConfig.repo ?? "agentrail-e2e-sandbox";
  const baseBranch = env.AGENTRAIL_SANDBOX_BASE_BRANCH ?? scenarioConfig.baseBranch ?? "main";
  const issueNumber = integerFromUnknown(env.AGENTRAIL_SANDBOX_ISSUE_NUMBER ?? scenarioConfig.issueNumber, "AGENTRAIL_SANDBOX_ISSUE_NUMBER");
  const pullNumber = integerFromUnknown(env.AGENTRAIL_SANDBOX_PULL_NUMBER ?? scenarioConfig.pullNumber, "AGENTRAIL_SANDBOX_PULL_NUMBER");
  const headBranch = env.AGENTRAIL_SANDBOX_HEAD_BRANCH ?? scenarioConfig.headBranch;
  if (!headBranch) {
    throw new Error("Live sandbox smoke is missing required env vars: AGENTRAIL_SANDBOX_HEAD_BRANCH");
  }
  const allowShip = parseBooleanEnv(env.AGENTRAIL_SANDBOX_ALLOW_SHIP, scenarioConfig.allowShip ?? false);
  const expectedHeadSha = env.AGENTRAIL_SANDBOX_EXPECTED_HEAD_SHA ?? scenarioConfig.expectedHeadSha ?? null;

  return { owner, repo, issueNumber, pullNumber, headBranch, baseBranch, allowShip, expectedHeadSha };
}

export async function resolveScenarioEnv({ env = process.env } = {}) {
  const scenarioId = env.AGENTRAIL_SANDBOX_SCENARIO_ID;
  if (!scenarioId) {
    return {};
  }

  const manifestPath = env.AGENTRAIL_SANDBOX_MANIFEST_PATH;
  if (!manifestPath) {
    throw new Error("AGENTRAIL_SANDBOX_MANIFEST_PATH is required when AGENTRAIL_SANDBOX_SCENARIO_ID is set.");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const scenario = manifest?.scenarios?.find?.((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    throw new Error(`Sandbox scenario ${scenarioId} was not found in ${manifestPath}.`);
  }

  const live = scenario.live ?? {};
  if (scenario.kind === "scratch") {
    return {
      owner: live.owner,
      repo: live.repo,
      baseBranch: scenario.baseBranch,
      allowShip: scenario.allowShip,
      expectedHeadSha: live.expectedHeadSha ?? null
    };
  }

  return {
    owner: live.owner,
    repo: live.repo,
    issueNumber: live.issueNumber,
    pullNumber: live.pullNumber,
    headBranch: live.headBranch,
    baseBranch: scenario.baseBranch,
    allowShip: scenario.allowShip,
    expectedHeadSha: live.expectedHeadSha ?? null
  };
}

async function bootstrapLiveApiKey({ baseUrl, agentId }) {
  const response = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `sandbox-bootstrap-${agentId}`,
    },
    body: JSON.stringify({
      agent: {
        id: agentId,
        displayName: "AgentRail Sandbox Agent",
        role: "sandbox_validator",
        externalIdentities: [],
      },
      scopes: [
        "auth:admin",
        "tasks:read",
        "tasks:write",
        "ci:read",
        "reviews:read",
        "ship:write",
      ],
      rateLimit: { windowSeconds: 60, maxRequests: 600 },
    }),
  });
  const body = await response.json();
  if (response.status !== 201) {
    throw new Error(`Failed to bootstrap sandbox API key: ${JSON.stringify(body)}`);
  }
  return body.data.apiKey;
}

function startServer({ scriptName, env }) {
  const output = [];
  const child = spawn("npm", ["run", scriptName], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  child.output = output;
  return child;
}

async function waitForHealth({ baseUrl, server }) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (server.exitCode !== null) {
      throw new Error(`AgentRail server exited early: ${server.output.join("")}`);
    }
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.status === "ok") {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for AgentRail health: ${server.output.join("")}`);
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    delay(2_000).then(() => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
    }),
  ]);
}

async function loadTypescriptSdk() {
  const distPath = path.join(repoRoot, "sdk", "typescript", "dist", "index.js");
  return import(pathToFileURL(distPath).href);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}: ${JSON.stringify(body)}`);
  }
  return body;
}

function resolvePort() {
  const raw = process.env.AGENTRAIL_SANDBOX_PORT ?? process.env.AGENTRAIL_PORT;
  if (raw) {
    return Number.parseInt(raw, 10);
  }
  return 36_000 + Math.floor(Math.random() * 2_000);
}

function numberEnv(name) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function integerFromUnknown(value, label) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(normalized)) {
    throw new Error(`Live sandbox smoke is missing required env vars: ${label}`);
  }
  return normalized;
}

function parseBooleanEnv(value, fallback) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Expected ${label} to be ${expected}, received ${actual}.`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      parsed.mode = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
    }
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

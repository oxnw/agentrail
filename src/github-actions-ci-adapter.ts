import { resolveTaskSource } from "./task-source-resolution.ts";
import type { TaskRecord } from "./task-store.ts";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_RUN_LIMIT = 20;
const MAX_FAILURE_SUMMARIES = 5;

export class CiStatusSourceError extends Error {
  declare statusCode: number;
  declare code: string;
  declare details: Record<string, unknown>;
  constructor(message, { statusCode = 502, code = "ci_source_unavailable", details = {} } = {}) {
    super(message);
    this.name = "CiStatusSourceError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class GitHubActionsCiAdapter {
  declare taskSources: any;
  declare githubToken: string | undefined;
  declare fetch: typeof globalThis.fetch;
  declare apiBaseUrl: string;
  declare runLimit: number;
  declare jobsByRunId: Map<string, any>;
  declare getTask: ((taskId: string) => TaskRecord | null) | null;
  constructor({
    taskSources = {},
    getTask = null,
    githubToken = process.env.GITHUB_TOKEN,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
    runLimit = DEFAULT_RUN_LIMIT
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("GitHubActionsCiAdapter requires a fetch implementation.");
    }

    this.taskSources = taskSources;
    this.getTask = getTask;
    this.githubToken = githubToken;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.runLimit = runLimit;
    this.jobsByRunId = new Map();
  }

  async getTaskCiStatus(taskId) {
    const source = resolveTaskSource(taskId, {
      taskSources: this.taskSources,
      getTask: this.getTask,
    });
    if (!source) {
      return null;
    }

    if (source.ciProvider && source.ciProvider !== "github_actions") {
      return null;
    }

    validateTaskSource(source);

    const runs = await this.listWorkflowRuns(source);
    const matchingRuns = filterRunsForSource(runs, source);
    const currentRuns = latestRunPerWorkflow(matchingRuns);
    const historicalRuns = matchingRuns.filter(
      (run) => !currentRuns.some((currentRun) => currentRun.id === run.id)
    );

    const workflowGroups = [];
    for (const run of currentRuns) {
      const jobs = await this.listJobs(source, run.id);
      workflowGroups.push({ run, jobs });
    }

    const failedChecks = [];
    const failureSummaries = [];
    const checks = [];
    for (const group of workflowGroups) {
      for (const job of group.jobs) {
        const status = normalizeStatus(job.status, job.conclusion);
        const check = toCheck(group.run, job, status);
        checks.push(check);

        if (status === "failed") {
          failedChecks.push({ run: group.run, job, check });
          const logText = await this.fetchJobLogs(source, job.id);
          failureSummaries.push(
            ...parseFailureSummaries({
              logText,
              checkName: job.name,
              workflow: group.run.name ?? workflowKey(group.run),
              maxItems: MAX_FAILURE_SUMMARIES - failureSummaries.length
            })
          );
        }
      }
    }

    const workflows = workflowGroups.map((group) => toWorkflowSummary(group.run, group.jobs));
    const summary = summarizeChecks(checks);
    const overallStatus = determineOverallStatus(summary);
    const flakyHints = await this.detectFlakyHints({
      source,
      failedChecks,
      historicalRuns
    });
    const availableActions = actionsForStatus(overallStatus);

    return {
      data: {
        taskId,
        submissionId: source.submissionId ?? null,
        overallStatus,
        summary,
        workflows,
        checks,
        failureSummaries,
        flakyHints,
        updatedAt: latestUpdatedAt(currentRuns),
        availableActions
      },
      availableActions,
      meta: {
        tokenBudgetHint: overallStatus === "passed" ? "compact" : "standard",
        truncatedFields: failureSummaries.length >= MAX_FAILURE_SUMMARIES ? ["failureSummaries"] : []
      }
    };
  }

  async listWorkflowRuns(source) {
    const params = new URLSearchParams({
      per_page: String(this.runLimit)
    });
    if (source.branch) {
      params.set("branch", source.branch);
    }

    const body = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/actions/runs?${params}`
    );
    return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  }

  async listJobs(source, runId) {
    if (this.jobsByRunId.has(runId)) {
      return this.jobsByRunId.get(runId);
    }

    const body = await this.fetchJson(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/actions/runs/${runId}/jobs?per_page=100`
    );
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    this.jobsByRunId.set(runId, jobs);
    return jobs;
  }

  async fetchJobLogs(source, jobId) {
    return this.fetchText(
      `${this.apiBaseUrl}/repos/${source.owner}/${source.repo}/actions/jobs/${jobId}/logs`
    );
  }

  async fetchJson(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw await toSourceError(response);
    }

    return response.json();
  }

  async fetchText(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw await toSourceError(response);
    }

    return response.text();
  }

  async detectFlakyHints({ source, failedChecks, historicalRuns }) {
    const hints = [];
    const seen = new Set();

    for (const { run, job } of failedChecks) {
      const key = `${run.path ?? run.name}:${job.name}`;
      if (seen.has(key)) {
        continue;
      }

      if (run.run_attempt > 1) {
        hints.push({
          checkName: job.name,
          confidence: "low",
          reason: "workflow has been re-run; compare attempts before changing code"
        });
        seen.add(key);
        continue;
      }

      const priorRuns = historicalRuns
        .filter((historicalRun) => workflowKey(historicalRun) === workflowKey(run))
        .slice(0, 5);

      for (const historicalRun of priorRuns) {
        const jobs = await this.listJobs(source, historicalRun.id);
        const matchingJob = jobs.find((candidate) => candidate.name === job.name);
        if (matchingJob && normalizeStatus(matchingJob.status, matchingJob.conclusion) === "passed") {
          hints.push({
            checkName: job.name,
            confidence: "medium",
            reason: "same check passed on a previous run for this head SHA"
          });
          seen.add(key);
          break;
        }
      }
    }

    return hints;
  }

  headers() {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };

    if (this.githubToken) {
      headers.authorization = `Bearer ${this.githubToken}`;
    }

    return headers;
  }
}

export function parseFailureSummaries({ logText, checkName, workflow, maxItems = MAX_FAILURE_SUMMARIES }) {
  if (maxItems <= 0) {
    return [];
  }

  const lines = String(logText ?? "").split(/\r?\n/);
  const summaries = [];

  for (let index = 0; index < lines.length && summaries.length < maxItems; index += 1) {
    const tapMatch = lines[index].match(/^\s*not ok \d+(?:\s+-\s+)?(.+)?$/i);
    if (!tapMatch) {
      continue;
    }

    const block = lines.slice(index, Math.min(index + 30, lines.length));
    summaries.push(
      cleanSummary({
        checkName,
        workflow,
        testName: tapMatch[1] ?? checkName,
        message: extractMessage(block),
        ...extractFileLine(block)
      })
    );
  }

  if (summaries.length > 0) {
    return summaries;
  }

  for (const line of lines) {
    const pytestMatch = line.match(/^FAILED\s+([^\s:]+)(?:::([^\s]+))?\s+-\s+(.+)$/);
    if (pytestMatch) {
      return [
        cleanSummary({
          checkName,
          workflow,
          testName: pytestMatch[2] ? `${pytestMatch[1]}::${pytestMatch[2]}` : pytestMatch[1],
          file: pytestMatch[1],
          line: null,
          message: pytestMatch[3]
        })
      ];
    }
  }

  const fallbackMessage = firstFailureLine(lines);
  return [
    cleanSummary({
      checkName,
      workflow,
      testName: checkName,
      file: null,
      line: null,
      message: fallbackMessage ?? "Job failed; no structured test failure found."
    })
  ];
}

function validateTaskSource(source) {
  for (const field of ["owner", "repo"]) {
    if (typeof source[field] !== "string" || source[field].length === 0) {
      throw new CiStatusSourceError(`Task CI source is missing GitHub ${field}.`, {
        statusCode: 500,
        code: "ci_source_misconfigured",
        details: {
          field,
          availableActions: ["contact_support"]
        }
      });
    }
  }
}

function filterRunsForSource(runs, source) {
  const filteredRuns = source.headSha
    ? runs.filter((run) => run.head_sha === source.headSha)
    : runs;

  return filteredRuns.sort((left, right) => compareDatesDesc(left.updated_at, right.updated_at));
}

function latestRunPerWorkflow(runs) {
  const runsByWorkflow = new Map();
  for (const run of runs) {
    const key = workflowKey(run);
    if (!runsByWorkflow.has(key)) {
      runsByWorkflow.set(key, run);
    }
  }

  return [...runsByWorkflow.values()];
}

function workflowKey(run) {
  return run.path ?? run.name ?? String(run.id);
}

function toWorkflowSummary(run, jobs) {
  const summary = summarizeChecks(jobs.map((job) => ({ status: normalizeStatus(job.status, job.conclusion) })));

  return {
    name: run.name ?? workflowKey(run),
    path: run.path ?? null,
    status: normalizeStatus(run.status, run.conclusion),
    passed: summary.passed,
    failed: summary.failed,
    running: summary.running,
    queued: summary.queued,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    url: run.html_url ?? null
  };
}

function toCheck(run, job, status) {
  return {
    name: job.name,
    workflow: run.name ?? workflowKey(run),
    status,
    url: job.html_url ?? null,
    durationSeconds: durationSeconds(job.started_at, job.completed_at),
    failureCount: status === "failed" ? 1 : 0
  };
}

function summarizeChecks(checks) {
  const summary = {
    total: checks.length,
    passed: 0,
    failed: 0,
    running: 0,
    queued: 0,
    cancelled: 0,
    skipped: 0
  };

  for (const check of checks) {
    summary[check.status] += 1;
  }

  return summary;
}

function determineOverallStatus(summary) {
  if (summary.failed > 0) {
    return "failed";
  }

  if (summary.cancelled > 0) {
    return "cancelled";
  }

  if (summary.running > 0) {
    return "running";
  }

  if (summary.queued > 0 || summary.total === 0) {
    return "queued";
  }

  return "passed";
}

function actionsForStatus(status) {
  if (status === "passed") {
    return ["view_review_feedback"];
  }

  if (status === "failed" || status === "cancelled") {
    return ["retry_failed_checks", "view_logs"];
  }

  return ["refresh"];
}

function normalizeStatus(status, conclusion) {
  if (status !== "completed") {
    if (status === "queued" || status === "waiting" || status === "requested" || status === "pending") {
      return "queued";
    }

    return "running";
  }

  if (conclusion === "success" || conclusion === "neutral") {
    return "passed";
  }

  if (conclusion === "skipped") {
    return "skipped";
  }

  if (conclusion === "cancelled") {
    return "cancelled";
  }

  return "failed";
}

function latestUpdatedAt(runs) {
  return runs
    .map((run) => run.updated_at)
    .filter(Boolean)
    .sort(compareDatesDesc)[0] ?? null;
}

function durationSeconds(startedAt, completedAt) {
  if (!startedAt || !completedAt) {
    return null;
  }

  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs)) {
    return null;
  }

  return Math.max(0, Math.round(durationMs / 1000));
}

function compareDatesDesc(left, right) {
  return new Date(right).getTime() - new Date(left).getTime();
}

function extractMessage(block) {
  const errorIndex = block.findIndex((line) => line.trim() === "error: |-");
  if (errorIndex >= 0) {
    const messageLine = block.slice(errorIndex + 1).find((line) => line.trim().length > 0);
    if (messageLine) {
      return messageLine.trim();
    }
  }

  const assertionLine = block.find((line) => /\b(?:AssertionError|Error):\s+/.test(line));
  if (assertionLine) {
    return assertionLine.replace(/^.*?(?:AssertionError|Error):\s+/, "").trim();
  }

  return firstFailureLine(block) ?? "Test failed.";
}

function extractFileLine(block) {
  for (const line of block) {
    const match = line.match(
      /\(?((?:[A-Za-z]:)?[^()\s]+?\.(?:cjs|cs|go|java|js|jsx|kt|mjs|php|py|rb|rs|ts|tsx)):(\d+)(?::\d+)?\)?/
    );
    if (match) {
      return {
        file: match[1],
        line: Number.parseInt(match[2], 10)
      };
    }
  }

  return {
    file: null,
    line: null
  };
}

function firstFailureLine(lines) {
  const line = lines.find((candidate) =>
    /\b(?:AssertionError|Error|Expected|FAILED|failure|failed)\b/i.test(candidate)
  );
  return line?.trim() ?? null;
}

function cleanSummary(summary) {
  return {
    checkName: truncate(summary.checkName, 120),
    workflow: truncate(summary.workflow, 120),
    testName: truncate(summary.testName, 180),
    file: summary.file ? truncate(summary.file, 180) : null,
    line: Number.isInteger(summary.line) ? summary.line : null,
    message: truncate(summary.message, 240)
  };
}

function truncate(value, maxLength) {
  const stringValue = String(value ?? "");
  if (stringValue.length <= maxLength) {
    return stringValue;
  }

  return `${stringValue.slice(0, maxLength - 3)}...`;
}

async function toSourceError(response) {
  const details: Record<string, unknown> = {
    sourceStatus: response.status,
    availableActions: ["retry"]
  };
  const body = await safeText(response);
  if (body) {
    details.sourceMessage = body.slice(0, 240);
  }

  if (response.status === 401 || response.status === 403) {
    return new CiStatusSourceError("GitHub Actions CI source rejected the request.", {
      statusCode: response.status === 403 ? 429 : 502,
      code: response.status === 403 ? "ci_source_rate_limited" : "ci_source_auth_failed",
      details
    });
  }

  if (response.status === 404) {
    return new CiStatusSourceError("GitHub Actions CI source was not found.", {
      statusCode: 404,
      code: "not_found",
      details
    });
  }

  return new CiStatusSourceError("GitHub Actions CI source is unavailable.", {
    details
  });
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

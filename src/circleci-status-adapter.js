import { createHmac, timingSafeEqual } from "node:crypto";

import { CiStatusSourceError } from "./github-actions-ci-adapter.js";

const DEFAULT_CIRCLECI_API_BASE_URL = "https://circleci.com/api/v2";
const DEFAULT_PIPELINE_LIMIT = 20;
const MAX_FAILURE_SUMMARIES = 5;

export class CircleCiStatusAdapter {
  constructor({
    taskSources = {},
    circleciToken = process.env.CIRCLECI_TOKEN,
    webhookSecret = process.env.CIRCLECI_WEBHOOK_SECRET || null,
    fetch = globalThis.fetch,
    apiBaseUrl = DEFAULT_CIRCLECI_API_BASE_URL,
    pipelineLimit = DEFAULT_PIPELINE_LIMIT
  } = {}) {
    if (typeof fetch !== "function") {
      throw new TypeError("CircleCiStatusAdapter requires a fetch implementation.");
    }

    this.taskSources = taskSources;
    this.circleciToken = circleciToken;
    this.webhookSecret = webhookSecret;
    this.fetch = fetch;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.pipelineLimit = pipelineLimit;
    this.jobsByWorkflowId = new Map();
    this.testResultsByJobKey = new Map();
    this.webhookSnapshots = new Map();
    this.processedWebhookIds = new Set();
  }

  async getTaskCiStatus(taskId) {
    const source = lookupTaskSource(this.taskSources, taskId);
    if (!source || !isCircleCiSource(source)) {
      return null;
    }

    validateTaskSource(source);

    const cachedSnapshot = this.webhookSnapshots.get(taskId);
    const currentSnapshot =
      cachedSnapshot && snapshotMatchesSource(cachedSnapshot, source)
        ? cachedSnapshot
        : await this.fetchSnapshot(source);

    const workflowGroups = currentSnapshot.workflows.map((workflow) => ({
      workflow,
      jobs: currentSnapshot.jobsByWorkflowId.get(workflow.id) ?? []
    }));

    const failedChecks = [];
    const checks = [];
    const failureSummaries = [];

    for (const group of workflowGroups) {
      for (const job of group.jobs) {
        const status = normalizeStatus(job.status);
        const check = toCheck(group.workflow, job, status);
        checks.push(check);

        if (status === "failed" && failureSummaries.length < MAX_FAILURE_SUMMARIES) {
          failedChecks.push({ workflow: group.workflow, job, check });
          const testResults = await this.listTests(source, job.job_number);
          failureSummaries.push(
            ...toFailureSummaries({
              testResults,
              checkName: job.name,
              workflow: group.workflow.name,
              maxItems: MAX_FAILURE_SUMMARIES - failureSummaries.length
            })
          );
        }
      }
    }

    const workflows = workflowGroups.map((group) => toWorkflowSummary(group.workflow, group.jobs));
    const summary = summarizeChecks(checks);
    const overallStatus = determineOverallStatus(summary);
    const flakyHints = detectFlakyHints({
      failedChecks,
      historicalSnapshots: currentSnapshot.historicalSnapshots ?? []
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
        updatedAt: currentSnapshot.updatedAt ?? null,
        availableActions
      },
      availableActions,
      meta: {
        tokenBudgetHint: overallStatus === "passed" ? "compact" : "standard",
        truncatedFields: failureSummaries.length >= MAX_FAILURE_SUMMARIES ? ["failureSummaries"] : []
      }
    };
  }

  async receiveWebhook({ headers = {}, rawBody = "" } = {}) {
    verifyWebhookSignature({
      secret: this.webhookSecret,
      signatureHeader: headers["circleci-signature"],
      rawBody
    });

    const payload = JSON.parse(rawBody || "{}");
    if (!payload.id || !payload.type) {
      throw new CiStatusSourceError("CircleCI webhook payload is missing required fields.", {
        statusCode: 400,
        code: "validation_error",
        details: {
          availableActions: ["retry"]
        }
      });
    }

    if (this.processedWebhookIds.has(payload.id)) {
      return {
        data: {
          accepted: true,
          deduplicated: true,
          matchedTasks: []
        },
        availableActions: []
      };
    }

    const matchedTasks = [];
    for (const [taskId, source] of iterateTaskSources(this.taskSources)) {
      if (!isCircleCiSource(source) || !webhookMatchesSource(payload, source)) {
        continue;
      }

      const snapshot = mergeWebhookSnapshot(this.webhookSnapshots.get(taskId), payload);
      this.webhookSnapshots.set(taskId, snapshot);
      matchedTasks.push(taskId);
    }

    this.processedWebhookIds.add(payload.id);

    return {
      data: {
        accepted: true,
        deduplicated: false,
        matchedTasks
      },
      availableActions: []
    };
  }

  async fetchSnapshot(source) {
    const pipelines = await this.listPipelines(source);
    const matchingPipelines = filterPipelinesForSource(pipelines, source);
    const [currentPipeline, ...historicalPipelines] = matchingPipelines;

    if (!currentPipeline) {
      return {
        pipeline: null,
        workflows: [],
        jobsByWorkflowId: new Map(),
        historicalSnapshots: [],
        updatedAt: null
      };
    }

    const currentSnapshot = await this.buildPipelineSnapshot(source, currentPipeline);
    const historicalSnapshots = [];
    for (const pipeline of historicalPipelines.slice(0, 3)) {
      historicalSnapshots.push(await this.buildPipelineSnapshot(source, pipeline));
    }

    return {
      ...currentSnapshot,
      historicalSnapshots
    };
  }

  async buildPipelineSnapshot(source, pipeline) {
    const workflows = await this.listWorkflows(pipeline.id);
    const jobsByWorkflowId = new Map();

    for (const workflow of workflows) {
      jobsByWorkflowId.set(workflow.id, await this.listJobs(workflow.id));
    }

    return {
      pipeline,
      workflows,
      jobsByWorkflowId,
      updatedAt: latestUpdatedAt([
        pipeline.updated_at,
        ...workflows.flatMap((workflow) => [workflow.stopped_at, workflow.created_at])
      ])
    };
  }

  async listPipelines(source) {
    const params = new URLSearchParams({
      branch: source.branch ?? "",
    });
    if (!source.branch) {
      params.delete("branch");
    }

    const body = await this.fetchJson(
      `${this.apiBaseUrl}/project/${source.projectSlug}/pipeline?${params.toString()}`
    );
    const items = Array.isArray(body.items) ? body.items : [];
    return items.slice(0, this.pipelineLimit);
  }

  async listWorkflows(pipelineId) {
    const body = await this.fetchJson(`${this.apiBaseUrl}/pipeline/${pipelineId}/workflow`);
    return Array.isArray(body.items) ? body.items : [];
  }

  async listJobs(workflowId) {
    if (this.jobsByWorkflowId.has(workflowId)) {
      return this.jobsByWorkflowId.get(workflowId);
    }

    const body = await this.fetchJson(`${this.apiBaseUrl}/workflow/${workflowId}/job`);
    const jobs = Array.isArray(body.items) ? body.items : [];
    this.jobsByWorkflowId.set(workflowId, jobs);
    return jobs;
  }

  async listTests(source, jobNumber) {
    const cacheKey = `${source.projectSlug}:${jobNumber}`;
    if (this.testResultsByJobKey.has(cacheKey)) {
      return this.testResultsByJobKey.get(cacheKey);
    }

    const body = await this.fetchJson(
      `${this.apiBaseUrl}/project/${source.projectSlug}/${jobNumber}/tests`
    );
    const items = Array.isArray(body.items) ? body.items : [];
    this.testResultsByJobKey.set(cacheKey, items);
    return items;
  }

  async fetchJson(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw await toSourceError(response);
    }

    return response.json();
  }

  headers() {
    const headers = {
      accept: "application/json"
    };

    if (this.circleciToken) {
      headers["Circle-Token"] = this.circleciToken;
    }

    return headers;
  }
}

function isCircleCiSource(source) {
  return source?.ciProvider === "circleci";
}

function lookupTaskSource(taskSources, taskId) {
  if (taskSources instanceof Map) {
    return taskSources.get(taskId) ?? null;
  }

  return taskSources?.[taskId] ?? null;
}

function iterateTaskSources(taskSources) {
  if (taskSources instanceof Map) {
    return taskSources.entries();
  }

  return Object.entries(taskSources ?? {});
}

function validateTaskSource(source) {
  if (typeof source.projectSlug !== "string" || source.projectSlug.length === 0) {
    throw new CiStatusSourceError("Task CI source is missing CircleCI projectSlug.", {
      statusCode: 500,
      code: "ci_source_misconfigured",
      details: {
        field: "projectSlug",
        availableActions: ["contact_support"]
      }
    });
  }
}

function filterPipelinesForSource(pipelines, source) {
  return pipelines
    .filter((pipeline) => {
      if (source.headSha && pipeline.vcs?.revision !== source.headSha) {
        return false;
      }

      if (source.branch && pipeline.vcs?.branch !== source.branch) {
        return false;
      }

      return true;
    })
    .sort((left, right) => compareDatesDesc(left.updated_at, right.updated_at));
}

function toWorkflowSummary(workflow, jobs) {
  const summary = summarizeChecks(jobs.map((job) => ({ status: normalizeStatus(job.status) })));

  return {
    name: workflow.name ?? workflow.id,
    path: null,
    status: normalizeStatus(workflow.status),
    passed: summary.passed,
    failed: summary.failed,
    running: summary.running,
    queued: summary.queued,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    url: workflow.url ?? null
  };
}

function toCheck(workflow, job, status) {
  const fallbackUrl =
    workflow.url && Number.isInteger(job.job_number) ? `${workflow.url}/jobs/${job.job_number}` : null;

  return {
    name: job.name,
    workflow: workflow.name ?? workflow.id,
    status,
    url: job.web_url ?? job.url ?? fallbackUrl,
    durationSeconds: durationSeconds(job.started_at, job.stopped_at),
    failureCount: status === "failed" ? 1 : 0
  };
}

function toFailureSummaries({ testResults, checkName, workflow, maxItems = MAX_FAILURE_SUMMARIES }) {
  if (maxItems <= 0) {
    return [];
  }

  const failedTests = testResults
    .filter((result) => normalizeTestResult(result.result) === "failed")
    .slice(0, maxItems);

  if (failedTests.length > 0) {
    return failedTests.map((result) => ({
      checkName: truncate(checkName, 120),
      workflow: truncate(workflow, 120),
      testName: truncate(result.name || result.classname || checkName, 180),
      file: result.file ? truncate(result.file, 180) : null,
      line: null,
      message: truncate(result.message || result.result || "Job failed.", 240)
    }));
  }

  return [
    {
      checkName: truncate(checkName, 120),
      workflow: truncate(workflow, 120),
      testName: truncate(checkName, 180),
      file: null,
      line: null,
      message: "Job failed; CircleCI did not report structured test results."
    }
  ];
}

function detectFlakyHints({ failedChecks, historicalSnapshots }) {
  const hints = [];
  const seen = new Set();

  for (const { workflow, job } of failedChecks) {
    const key = `${workflow.name}:${job.name}`;
    if (seen.has(key)) {
      continue;
    }

    const passedPreviously = historicalSnapshots.some((snapshot) => {
      const jobs = snapshot.jobsByWorkflowId.get(snapshot.workflows.find(
        (candidate) => candidate.name === workflow.name
      )?.id);
      return jobs?.some(
        (candidate) => candidate.name === job.name && normalizeStatus(candidate.status) === "passed"
      );
    });

    if (passedPreviously) {
      hints.push({
        checkName: job.name,
        confidence: "medium",
        reason: "same check passed on a previous pipeline for this head SHA"
      });
      seen.add(key);
    }
  }

  return hints;
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

function normalizeStatus(status) {
  const normalized = String(status ?? "").toLowerCase();

  if (["success", "successful"].includes(normalized)) {
    return "passed";
  }

  if (["queued", "pending", "not_run", "blocked", "on_hold"].includes(normalized)) {
    return "queued";
  }

  if (["running", "failing"].includes(normalized)) {
    return "running";
  }

  if (["canceled", "cancelled"].includes(normalized)) {
    return "cancelled";
  }

  if (normalized === "skipped") {
    return "skipped";
  }

  return "failed";
}

function normalizeTestResult(result) {
  return String(result ?? "").toLowerCase() === "failure" ? "failed" : String(result ?? "").toLowerCase();
}

function durationSeconds(startedAt, stoppedAt) {
  if (!startedAt || !stoppedAt) {
    return null;
  }

  const durationMs = new Date(stoppedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(durationMs)) {
    return null;
  }

  return Math.max(0, Math.round(durationMs / 1000));
}

function latestUpdatedAt(values) {
  return values.filter(Boolean).sort(compareDatesDesc)[0] ?? null;
}

function compareDatesDesc(left, right) {
  return new Date(right).getTime() - new Date(left).getTime();
}

function truncate(value, maxLength) {
  const stringValue = String(value ?? "");
  if (stringValue.length <= maxLength) {
    return stringValue;
  }

  return `${stringValue.slice(0, maxLength - 3)}...`;
}

function verifyWebhookSignature({ secret, signatureHeader, rawBody }) {
  if (!secret) {
    return;
  }

  const headerValue = String(signatureHeader ?? "");
  const v1Signature = headerValue
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("v1="))
    ?.slice(3);

  if (!v1Signature) {
    throw new CiStatusSourceError("CircleCI webhook signature is missing or invalid.", {
      statusCode: 401,
      code: "ci_webhook_unauthorized",
      details: {
        availableActions: ["retry"]
      }
    });
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const actualBuffer = Buffer.from(v1Signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new CiStatusSourceError("CircleCI webhook signature is missing or invalid.", {
      statusCode: 401,
      code: "ci_webhook_unauthorized",
      details: {
        availableActions: ["retry"]
      }
    });
  }
}

function webhookMatchesSource(payload, source) {
  if (normalizeProjectSlug(source.projectSlug) !== normalizeProjectSlug(payload.project?.slug)) {
    return false;
  }

  if (source.branch && payload.pipeline?.vcs?.branch !== source.branch) {
    return false;
  }

  if (source.headSha && payload.pipeline?.vcs?.revision !== source.headSha) {
    return false;
  }

  return true;
}

function snapshotMatchesSource(snapshot, source) {
  return (
    normalizeProjectSlug(snapshot.projectSlug) === normalizeProjectSlug(source.projectSlug) &&
    (!source.branch || snapshot.branch === source.branch) &&
    (!source.headSha || snapshot.headSha === source.headSha)
  );
}

function mergeWebhookSnapshot(previousSnapshot, payload) {
  const workflow = normalizeWebhookWorkflow(payload.workflow);
  const job = normalizeWebhookJob(payload.job, workflow);
  const workflowsById = new Map(previousSnapshot?.workflowsById ?? []);
  const jobsByWorkflowId = new Map(previousSnapshot?.jobsByWorkflowId ?? []);

  if (workflow) {
    workflowsById.set(workflow.id, {
      ...workflowsById.get(workflow.id),
      ...workflow
    });
  }

  if (job && workflow) {
    const jobs = jobsByWorkflowId.get(workflow.id) ?? [];
    const nextJobs = upsertById(jobs, job);
    jobsByWorkflowId.set(workflow.id, nextJobs);
  }

  return {
    projectSlug: payload.project?.slug ?? previousSnapshot?.projectSlug ?? null,
    branch: payload.pipeline?.vcs?.branch ?? previousSnapshot?.branch ?? null,
    headSha: payload.pipeline?.vcs?.revision ?? previousSnapshot?.headSha ?? null,
    pipeline: payload.pipeline
      ? {
          id: payload.pipeline.id,
          number: payload.pipeline.number,
          updated_at: payload.happened_at ?? payload.pipeline.created_at ?? null,
          vcs: {
            branch: payload.pipeline.vcs?.branch ?? null,
            revision: payload.pipeline.vcs?.revision ?? null
          }
        }
      : previousSnapshot?.pipeline ?? null,
    workflows: [...workflowsById.values()].sort((left, right) =>
      compareDatesDesc(left.stopped_at ?? left.created_at, right.stopped_at ?? right.created_at)
    ),
    workflowsById,
    jobsByWorkflowId,
    historicalSnapshots: previousSnapshot?.historicalSnapshots ?? [],
    updatedAt: payload.happened_at ?? previousSnapshot?.updatedAt ?? null
  };
}

function normalizeWebhookWorkflow(workflow) {
  if (!workflow?.id) {
    return null;
  }

  return {
    id: workflow.id,
    name: workflow.name ?? workflow.id,
    status: workflow.status ?? "running",
    created_at: workflow.created_at ?? null,
    stopped_at: workflow.stopped_at ?? null,
    url: workflow.url ?? null
  };
}

function normalizeWebhookJob(job, workflow) {
  if (!job?.id) {
    return null;
  }

  return {
    id: job.id,
    job_number: job.number ?? job.job_number ?? null,
    name: job.name ?? job.id,
    status: job.status ?? "running",
    started_at: job.started_at ?? null,
    stopped_at: job.stopped_at ?? null,
    web_url:
      job.web_url ??
      job.url ??
      (workflow?.url && Number.isInteger(job.number ?? job.job_number)
        ? `${workflow.url}/jobs/${job.number ?? job.job_number}`
        : null)
  };
}

function upsertById(items, nextItem) {
  const index = items.findIndex((candidate) => candidate.id === nextItem.id);
  if (index === -1) {
    return [...items, nextItem];
  }

  const updated = [...items];
  updated[index] = {
    ...updated[index],
    ...nextItem
  };
  return updated;
}

function normalizeProjectSlug(value) {
  return String(value ?? "").trim().toLowerCase();
}

async function toSourceError(response) {
  const details = {
    sourceStatus: response.status,
    availableActions: ["retry"]
  };
  const body = await safeText(response);
  if (body) {
    details.sourceMessage = body.slice(0, 240);
  }

  const code =
    response.status === 401
      ? "ci_source_auth_failed"
      : response.status === 429
        ? "ci_source_rate_limited"
        : "ci_source_unavailable";
  const statusCode = response.status === 429 ? 429 : 502;

  return new CiStatusSourceError("CircleCI source rejected the request.", {
    statusCode,
    code,
    details
  });
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

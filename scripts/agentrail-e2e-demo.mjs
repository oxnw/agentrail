#!/usr/bin/env node
import { once } from "node:events";
import { performance } from "node:perf_hooks";

import { AgentRailClient } from "../sdk/typescript/dist/index.js";
import { createAgentShipCycleDemoStore } from "../src/agent-ship-cycle-demo.js";
import { createServer } from "../src/app.js";
import { TaskEventStore } from "../src/task-event-store.js";

const JSON_OUTPUT = process.argv.includes("--json");

async function main() {
  const report = await runDemo();

  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  process.stdout.write(formatReport(report));
}

async function runDemo() {
  const now = () => new Date("2026-05-01T10:00:00Z");
  const eventStore = new TaskEventStore({ now });
  const taskLifecycleStore = createAgentShipCycleDemoStore({ now, eventStore });
  const server = createServer({
    store: eventStore,
    taskLifecycleStore,
    ciStatusAdapter: taskLifecycleStore,
    reviewFeedbackAdapter: taskLifecycleStore,
    now
  });

  const traffic = [];
  const restoreFetch = instrumentFetch(traffic);

  try {
    const baseUrl = await listen(server);
    const client = new AgentRailClient({
      baseUrl,
      apiKey: "ar_live_demo_key",
      retry: { maxAttempts: 1 }
    });
    const startedAt = performance.now();
    const steps = [];

    const taskList = await client.listMyTasks({ status: "in_progress", limit: 1 });
    steps.push("list_my_tasks");
    const task = taskList.data[0];

    await client.submitTask(
      task.id,
      {
        summary: "Implemented the failing endpoint and opened a pull request.",
        artifacts: [
          {
            type: "pull_request",
            url: "https://github.com/oxnw/agentrail/pull/42"
          }
        ],
        checks: [{ name: "unit-tests", status: "failed" }],
        notes: "First pass intentionally demonstrates the feedback loop."
      },
      "submit-demo-1"
    );
    steps.push("submit_first_pass");

    const failedCi = await client.getTaskCiStatus(task.id);
    steps.push("read_failed_ci");

    const requestedChanges = await client.getTaskReviewFeedback(task.id);
    steps.push("read_review_feedback");

    await client.submitTask(
      task.id,
      {
        summary: "Fixed idempotency handling and added a regression test.",
        artifacts: [
          {
            type: "pull_request",
            url: "https://github.com/oxnw/agentrail/pull/42"
          },
          {
            type: "commit",
            url: "https://github.com/oxnw/agentrail/commit/b5bc7f86"
          }
        ],
        checks: [{ name: "unit-tests", status: "passed" }],
        notes: null
      },
      "submit-demo-2"
    );
    steps.push("submit_fix");

    const greenCi = await client.getTaskCiStatus(task.id);
    steps.push("read_green_ci");

    const approvedReview = await client.getTaskReviewFeedback(task.id);
    steps.push("read_approved_review");

    const ship = await client.shipTask(
      task.id,
      {
        mode: "merge_and_deploy",
        targetEnvironment: "production",
        expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
      },
      "ship-demo-1"
    );
    steps.push("ship");

    const elapsedMs = Math.round(performance.now() - startedAt);
    const agentRailBytes = traffic.reduce(
      (total, entry) => total + entry.requestBytes + entry.responseBytes,
      0
    );
    const rawGitHubBytes = Buffer.byteLength(JSON.stringify(createRawGitHubEquivalentFixture()));
    const agentRailTokens = estimateTokens(agentRailBytes);
    const rawGitHubTokens = estimateTokens(rawGitHubBytes);

    return {
      title: "AgentRail issue to ship demo",
      steps,
      result: {
        taskId: task.id,
        firstCiStatus: failedCi.data.overallStatus,
        firstReviewOutcome: requestedChanges.data.latestDecision.outcome,
        finalCiStatus: greenCi.data.overallStatus,
        finalReviewOutcome: approvedReview.data.latestDecision.outcome,
        shipStatus: ship.data.status,
        operationId: ship.data.operationId
      },
      metrics: {
        timeToCompletionMs: elapsedMs,
        successRate: 1,
        agentRail: {
          operations: traffic.length,
          bytes: agentRailBytes,
          estimatedTokens: agentRailTokens
        },
        rawGitHubEquivalent: {
          operations: 10,
          bytes: rawGitHubBytes,
          estimatedTokens: rawGitHubTokens
        },
        estimatedTokenSavingsPercent: Math.round(
          ((rawGitHubTokens - agentRailTokens) / rawGitHubTokens) * 100
        )
      }
    };
  } finally {
    restoreFetch();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function instrumentFetch(traffic) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const response = await originalFetch(url, init);
    const clone = response.clone();
    const responseText = await clone.text();

    traffic.push({
      method: init.method ?? "GET",
      url: String(url),
      status: response.status,
      requestBytes: Buffer.byteLength(init.body ?? ""),
      responseBytes: Buffer.byteLength(responseText)
    });

    return response;
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function estimateTokens(byteLength) {
  return Math.ceil(byteLength / 4);
}

function createRawGitHubEquivalentFixture() {
  const logExcerpt = [
    "Run npm test",
    "POST /tasks/{id}/ship rejects non-idempotent retries",
    "AssertionError [ERR_ASSERTION]: expected 409 conflict but received 202",
    "at test/ship-endpoint.test.js:58:10",
    "worker retry used a different payload for the same idempotency key"
  ].join("\n");

  return {
    issue: {
      number: 42,
      title: "Fix idempotent ship retry handling",
      body: "Long issue body with acceptance criteria, previous attempts, and repository context.",
      labels: ["bug", "agentrail", "api"],
      comments: Array.from({ length: 8 }, (_, index) => ({
        id: 1000 + index,
        body: `Thread comment ${index + 1}: discussion and partial diagnosis for the agent.`
      }))
    },
    pullRequest: {
      number: 42,
      head: { sha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0" },
      files: Array.from({ length: 14 }, (_, index) => ({
        filename: `src/file-${index + 1}.js`,
        patch: "@@ -1,3 +1,6 @@\n- old implementation\n+ new implementation\n+ regression coverage"
      }))
    },
    checkRuns: Array.from({ length: 6 }, (_, index) => ({
      name: `check-${index + 1}`,
      status: index === 0 ? "completed" : "queued",
      conclusion: index === 0 ? "failure" : null,
      output: {
        title: "CI output",
        summary: logExcerpt.repeat(4)
      }
    })),
    reviews: [
      {
        state: "CHANGES_REQUESTED",
        body: "Fix ship idempotency before merge.",
        comments: [
          {
            path: "src/app.js",
            line: 211,
            body: "Different idempotency payloads must return 409."
          }
        ]
      },
      {
        state: "APPROVED",
        body: "Approved after regression coverage was added.",
        comments: []
      }
    ],
    deployments: [
      {
        environment: "production",
        state: "queued",
        log_url: "https://github.com/oxnw/agentrail/actions/runs/4242"
      }
    ]
  };
}

function formatReport(report) {
  return [
    "# AgentRail issue to ship demo",
    "",
    `Task: ${report.result.taskId}`,
    `Result: ship ${report.result.shipStatus} (${report.result.operationId})`,
    "",
    "Steps:",
    ...report.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Metrics:",
    `- Time to completion: ${report.metrics.timeToCompletionMs} ms`,
    `- Success rate: ${report.metrics.successRate * 100}%`,
    `- AgentRail tokens: ${report.metrics.agentRail.estimatedTokens}`,
    `- Raw GitHub-equivalent tokens: ${report.metrics.rawGitHubEquivalent.estimatedTokens}`,
    `- Estimated token savings: ${report.metrics.estimatedTokenSavingsPercent}%`,
    ""
  ].join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

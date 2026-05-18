import test from "node:test";
import assert from "node:assert/strict";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const FIXTURE_NOW = new Date("2026-05-12T09:00:00.000Z");
const now = () => FIXTURE_NOW;

test("projectCiState makes in-review CI failures actionable without relaunching on recovery", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-RUNNER-1",
    title: "CI transition",
    description: "Exercise CI lifecycle transitions.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
  });

  const failed = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "failed",
    summary: { total: 1, failed: 1 },
    headline: "Unit tests failed",
    updatedAt: "2026-05-12T09:01:00.000Z",
  });

  assert.equal(failed?.outcome, "failed_transition");
  assert.deepEqual(failed?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(failed?.task.status, "in_review");
  assert.equal(eventStore.events.at(-1)?.type, "task.ci_failed");
  assert.deepEqual(eventStore.events.at(-1)?.data.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.data.affectedAgentId, "agt_runner");

  const recovered = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "passed",
    summary: { total: 1, passed: 1 },
    headline: "Unit tests passed",
    updatedAt: "2026-05-12T09:02:00.000Z",
  });

  assert.equal(recovered?.outcome, "recovered_transition");
  assert.deepEqual(recovered?.task.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(recovered?.task.status, "in_review");
  assert.equal(eventStore.events.at(-1)?.type, "task.ci_recovered");
  assert.deepEqual(eventStore.events.at(-1)?.data.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
});

test("projectCiState preserves requested review changes when CI recovers", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-REVIEW-BLOCKED-1",
    title: "CI recovery with review blocker",
    description: "Exercise CI recovery while review changes are still requested.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["fix", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "changes_requested",
    ciStatus: "failed",
  });

  const recovered = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "passed",
    summary: { total: 1, passed: 1 },
    headline: "Unit tests passed",
    updatedAt: "2026-05-12T09:03:00.000Z",
  });

  assert.equal(recovered?.outcome, "recovered_transition");
  assert.deepEqual(recovered?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(recovered?.task.reviewOutcome, "changes_requested");
  assert.equal(eventStore.events.at(-1)?.type, "task.ci_recovered");
  assert.deepEqual(eventStore.events.at(-1)?.data.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
});

test("shipTask delegates to provider and records shipped task state", async () => {
  const eventStore = new TaskEventStore({ now });
  const calls: Array<{ taskId: string; payload: unknown; idempotencyKey: string | undefined }> = [];
  const queue = new AgentTaskQueue({
    now,
    eventStore,
    delegate: {
      async shipTask(taskId, payload, idempotencyKey) {
        calls.push({ taskId, payload, idempotencyKey });
        return {
          data: {
            taskId,
            operationId: "ghship_123",
            status: "merged",
            prUrl: "https://github.com/acme/widgets/pull/123",
            prNumber: 123,
            mergeCommitSha: "merge-sha-123",
            availableActions: ["rollback"],
          },
          availableActions: ["rollback"],
        };
      },
    },
  });
  const task = queue.createTask({
    identifier: "SHIP-STATE-1",
    title: "Ship task state",
    description: "Exercise provider-backed shipping.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
    source: {
      provider: "github",
      owner: "acme",
      repo: "widgets",
      issueNumber: 122,
      pullNumber: 123,
      branch: "agentrail/ship-state",
      baseBranch: "main",
    },
  });

  const response = await queue.shipTask(task.id, { mergeMethod: "squash" }, "ship-state-1");
  const updated = queue.getRawTask(task.id);

  assert.equal((response as any).data.operationId, "ghship_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.taskId, task.id);
  assert.equal(calls[0]?.idempotencyKey, "ship-state-1");
  assert.equal(updated?.status, "done");
  assert.deepEqual(updated?.availableActions, ["rollback"]);
  assert.equal(updated?.shipOperation?.id, "ghship_123");
  assert.equal(updated?.shipOperation?.status, "merged");
  assert.equal(updated?.shipOperation?.mode, "squash");
  assert.equal(updated?.source?.mergedSha, "merge-sha-123");
  assert.equal(eventStore.events.at(-1)?.type, "task.shipped");
  assert.equal(eventStore.events.at(-1)?.data.operationId, "ghship_123");

  const replay = await queue.shipTask(task.id, { mergeMethod: "squash" }, "ship-state-1");
  assert.equal((replay as any).data.operationId, "ghship_123");
  assert.equal(calls.length, 1);
});

test("blockTaskAwaitingUser blocks in-review tasks after managed runner policy violations", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "RUNNER-POLICY-IN-REVIEW-1",
    title: "Runner policy in review",
    description: "Exercise policy blockers for review-fix runs.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["fix", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "changes_requested",
  });

  await queue.blockTaskAwaitingUser(task.id, {
    sourceRunId: "run_policy_violation",
    sourceAgentId: "agt_runner",
    reason: "runner_policy_violation",
    actionRequired: "Remove denied instruction file changes.",
    resumeInstructions: "Retry after the denied file changes are removed.",
  }, "policy-violation-in-review", "agt_runner");

  const updated = queue.getRawTask(task.id);
  assert.equal(updated?.status, "blocked");
  assert.deepEqual(updated?.availableActions, ["resolve_blocker"]);
  assert.equal(updated?.blocker?.kind, "awaiting_user");
  assert.equal(updated?.blocker?.reason, "runner_policy_violation");
  assert.equal(eventStore.events.at(-1)?.type, "task.awaiting_user");
  assert.equal(eventStore.events.at(-1)?.data.previousStatus, "in_review");
});

test("blockTaskAwaitingUser does not block ready-to-ship in-review tasks", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "RUNNER-POLICY-IN-REVIEW-SHIP-1",
    title: "Ready to ship in review",
    description: "Ready-to-ship review tasks should not accept runner blockers.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "approved",
    ciStatus: "passed",
  });

  await assert.rejects(
    queue.blockTaskAwaitingUser(task.id, {
      sourceRunId: "run_policy_violation",
      sourceAgentId: "agt_runner",
      reason: "runner_policy_violation",
      actionRequired: "Remove denied instruction file changes.",
      resumeInstructions: "Retry after the denied file changes are removed.",
    }, "policy-violation-ready-to-ship", "agt_runner"),
    {
      name: "TaskLifecycleError",
      statusCode: 409,
      code: "conflict",
      message: "Task is not in a blockable state.",
    },
  );

  const updated = queue.getRawTask(task.id);
  assert.equal(updated?.status, "in_review");
  assert.deepEqual(updated?.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(updated?.blocker, null);
  assert.equal(eventStore.events.length, 0);
});

test("submitTask clears stale blockers after a fix submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({
    now,
    eventStore,
    delegate: {
      submitTask: async () => ({
        data: {
          submissionId: "sub_fix_b",
          prUrl: "https://github.com/oxnw/agentrail/pull/42",
          prNumber: 42,
          head: "agentrail/fix-loop",
          base: "main",
          headSha: "commit-b",
        },
      }),
    },
  });
  const task = queue.createTask({
    identifier: "FIX-STALE-BLOCKERS-1",
    title: "Fix stale blockers",
    description: "Exercise reset after fix submission.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["fix", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "changes_requested",
    ciStatus: "failed",
    source: {
      provider: "github",
      owner: "oxnw",
      repo: "agentrail",
      issueNumber: 42,
      pullNumber: 42,
      branch: "agentrail/fix-loop",
      baseBranch: "main",
      headSha: "commit-a",
    },
    submissions: [
      {
        id: "sub_fix_a",
        summary: "Initial fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:00:00.000Z",
        prUrl: "https://github.com/oxnw/agentrail/pull/42",
        prNumber: 42,
        branch: "agentrail/fix-loop",
        baseBranch: "main",
        headSha: "commit-a",
      },
    ],
    latestSubmissionId: "sub_fix_a",
  });

  await queue.submitTask(task.id, {
    summary: "Address CI and review feedback.",
    pullRequest: {
      head: "agentrail/fix-loop",
      base: "main",
      headSha: "commit-b",
    },
  }, "submit-fix-b");

  const updated = queue.getRawTask(task.id);
  assert.equal(updated?.status, "in_review");
  assert.equal(updated?.latestSubmissionId, "sub_fix_b");
  assert.equal(updated?.source?.headSha, "commit-b");
  assert.equal(updated?.ciStatus, null);
  assert.equal(updated?.ci, null);
  assert.equal(updated?.reviewOutcome, null);
  assert.deepEqual(updated?.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.updated");
  assert.deepEqual(eventStore.events.at(-1)?.data.availableActions, ["view_ci_status", "view_review_feedback"]);
});

test("submitTask treats resolved blocker retries as fix submissions", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({
    now,
    eventStore,
    delegate: {
      submitTask: async () => ({
        data: {
          submissionId: "sub_fix_retry",
          prUrl: "https://github.com/oxnw/agentrail/pull/42",
          prNumber: 42,
          head: "agentrail/fix-loop",
          base: "main",
          headSha: "commit-retry",
        },
      }),
    },
  });
  const task = queue.createTask({
    identifier: "FIX-RESOLVED-BLOCKER-1",
    title: "Retry after resolved blocker",
    description: "Exercise stale blocker reset after resolving an awaiting-user blocker.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["fix", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "changes_requested",
    ciStatus: "failed",
    source: {
      provider: "github",
      owner: "oxnw",
      repo: "agentrail",
      issueNumber: 42,
      pullNumber: 42,
      prUrl: "https://github.com/oxnw/agentrail/pull/42",
      branch: "agentrail/fix-loop",
      baseBranch: "main",
      headSha: "commit-old",
    },
    submissions: [
      {
        id: "sub_fix_old",
        summary: "Previous fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T08:45:00.000Z",
        prUrl: "https://github.com/oxnw/agentrail/pull/42",
        prNumber: 42,
        branch: "agentrail/fix-loop",
        baseBranch: "main",
        headSha: "commit-old",
      },
    ],
    latestSubmissionId: "sub_fix_old",
  });

  await queue.blockTaskAwaitingUser(task.id, {
    sourceRunId: "run_policy_violation",
    sourceAgentId: "agt_runner",
    reason: "runner_policy_violation",
    actionRequired: "Remove denied instruction file changes.",
    resumeInstructions: "Retry after the denied file changes are removed.",
  }, "policy-violation-before-retry", "agt_runner");
  await queue.resolveBlocker(task.id, {
    resolutionSummary: "Denied file changes removed.",
  }, "resolve-policy-violation", "usr_owner", "user");
  await queue.startTask(task.id, {}, "start-resolved-blocker-retry", "agt_runner");
  await queue.submitTask(task.id, {
    summary: "Retry after user resolved blocker.",
    pullRequest: {
      head: "agentrail/fix-loop",
      base: "main",
      headSha: "commit-retry",
    },
  }, "submit-resolved-blocker-retry");

  const updated = queue.getRawTask(task.id);
  assert.equal(updated?.status, "in_review");
  assert.equal(updated?.latestSubmissionId, "sub_fix_retry");
  assert.equal(updated?.source?.headSha, "commit-retry");
  assert.equal(updated?.ciStatus, null);
  assert.equal(updated?.ci, null);
  assert.equal(updated?.reviewOutcome, null);
  assert.deepEqual(updated?.availableActions, ["view_ci_status", "view_review_feedback"]);
});

test("projectReviewState ignores requested changes older than the latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-STALE-1",
    title: "Stale review feedback",
    description: "Exercise stale review feedback after a fix.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const staleReview = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Old feedback on the previous commit.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:05:00.000Z",
    decisionScope: "pull_request",
  });

  assert.equal(staleReview?.outcome, "unchanged");
  assert.equal(staleReview?.task.reviewOutcome, null);
  assert.deepEqual(staleReview?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);
});

test("projectReviewState accepts older requested changes when head SHA matches latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-SHA-FRESH-1",
    title: "Review feedback raced local submission time",
    description: "Exercise SHA-based freshness for review feedback.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const review = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Feedback created before AgentRail recorded submission.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:05:00.000Z",
    headSha: "commit-b",
    decisionScope: "pull_request",
  });

  assert.equal(review?.outcome, "changes_requested_transition");
  assert.equal(review?.task.reviewOutcome, "changes_requested");
  assert.deepEqual(review?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_changes_requested");
});

test("projectReviewState ignores newer requested changes when head SHA differs from latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-SHA-STALE-1",
    title: "Review feedback from a different commit",
    description: "Exercise SHA mismatch freshness for review feedback.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const review = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Different commit requested changes after local submission timestamp.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:15:00.000Z",
    headSha: "commit-a",
    decisionScope: "pull_request",
  });

  assert.equal(review?.outcome, "unchanged");
  assert.equal(review?.task.reviewOutcome, null);
  assert.deepEqual(review?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);
});

test("projectReviewState re-enables fix for fresh requested changes", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-FRESH-1",
    title: "Fresh review feedback",
    description: "Exercise fresh review feedback after a fix.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const freshReview = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Fresh feedback on the latest commit.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:15:00.000Z",
    decisionScope: "pull_request",
  });

  assert.equal(freshReview?.outcome, "changes_requested_transition");
  assert.equal(freshReview?.task.reviewOutcome, "changes_requested");
  assert.deepEqual(freshReview?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_changes_requested");
});

test("projectReviewState does not enable ship when a fix approval arrives before CI passes", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-APPROVED-CI-PENDING-1",
    title: "Approval before fix CI",
    description: "Exercise review approval before latest fix CI is green.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    ciStatus: null,
    reviewOutcome: null,
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const approved = await queue.projectReviewState(task.id, {
    outcome: "approved",
    summary: "Approved before CI completed.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:15:00.000Z",
    headSha: "commit-b",
    decisionScope: "pull_request",
  });

  assert.equal(approved?.outcome, "approved_transition");
  assert.equal(approved?.task.reviewOutcome, "approved");
  assert.deepEqual(approved?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_approved");

  const repeatedApproval = await queue.projectReviewState(task.id, {
    outcome: "approved",
    summary: "Approval observed again before CI completed.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:16:00.000Z",
    headSha: "commit-b",
    decisionScope: "pull_request",
  });

  assert.equal(repeatedApproval?.outcome, "unchanged");
  assert.equal(repeatedApproval?.task.reviewOutcome, "approved");
  assert.deepEqual(repeatedApproval?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
});

test("projectCiState ignores CI failures older than the latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-STALE-1",
    title: "Stale CI feedback",
    description: "Exercise stale CI feedback after a fix.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const staleCi = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "failed",
    summary: { total: 1, failed: 1 },
    headline: "Old failure.",
    updatedAt: "2026-05-12T09:05:00.000Z",
  });

  assert.equal(staleCi?.outcome, "unchanged");
  assert.equal(staleCi?.task.ciStatus, null);
  assert.deepEqual(staleCi?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);
});

test("projectCiState accepts older CI observations when head SHA matches latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-SHA-FRESH-1",
    title: "CI raced local submission time",
    description: "Exercise SHA-based freshness for CI.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const ci = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "passed",
    summary: { total: 1, passed: 1 },
    headline: "Latest commit passed before local submission timestamp.",
    updatedAt: "2026-05-12T09:05:00.000Z",
    headSha: "commit-b",
  });

  assert.equal(ci?.outcome, "unchanged");
  assert.equal(ci?.task.ciStatus, "passed");
  assert.deepEqual(ci?.task.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
});

test("projectCiState ignores newer CI observations when head SHA differs from latest submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-SHA-STALE-1",
    title: "CI from a different commit",
    description: "Exercise SHA mismatch freshness for CI.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const ci = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "failed",
    summary: { total: 1, failed: 1 },
    headline: "Different commit failed after local submission timestamp.",
    updatedAt: "2026-05-12T09:15:00.000Z",
    headSha: "commit-a",
  });

  assert.equal(ci?.outcome, "unchanged");
  assert.equal(ci?.task.ciStatus, null);
  assert.deepEqual(ci?.task.availableActions, ["view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);
});

test("projectReviewState compares freshness against the last duplicate PR submission id", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-DUPLICATE-SUBMISSION-ID-1",
    title: "Review feedback after repeated PR submission ids",
    description: "Exercise GitHub PR submissions that reuse ghpr_<number> ids.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "ghpr_42",
        summary: "Initial PR",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:00:00.000Z",
        headSha: "old-sha",
      },
      {
        id: "ghpr_42",
        summary: "Fix push",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "new-sha",
      },
    ],
    latestSubmissionId: "ghpr_42",
    source: {
      provider: "github",
      owner: "oxnw",
      repo: "agentrail",
      pullNumber: 42,
      branch: "agentrail/fix-loop",
      baseBranch: "main",
      headSha: "new-sha",
    },
  });

  const review = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Feedback on the latest fix push.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:15:00.000Z",
    headSha: "new-sha",
    decisionScope: "pull_request",
  });

  assert.equal(review?.outcome, "changes_requested_transition");
  assert.equal(review?.task.reviewOutcome, "changes_requested");
  assert.deepEqual(review?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
});

test("projectCiState allows shipping after fresh passing CI on a fix submission", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "CI-FRESH-PASS-1",
    title: "Fresh passing CI",
    description: "Exercise fresh passing CI after a fix.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["view_ci_status", "view_review_feedback"],
    submissions: [
      {
        id: "sub_fix_b",
        summary: "Fix attempt",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-12T09:10:00.000Z",
        headSha: "commit-b",
      },
    ],
    latestSubmissionId: "sub_fix_b",
  });

  const freshCi = await queue.projectCiState(task.id, {
    provider: "github_actions",
    overallStatus: "passed",
    summary: { total: 1, passed: 1 },
    headline: "Fresh CI passed.",
    updatedAt: "2026-05-12T09:15:00.000Z",
  });

  assert.equal(freshCi?.outcome, "unchanged");
  assert.equal(freshCi?.task.ciStatus, "passed");
  assert.deepEqual(freshCi?.task.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);
});

test("projectReviewState relaunches agents only for requested review changes", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-RUNNER-1",
    title: "Review transition",
    description: "Exercise review lifecycle transitions.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["ship", "view_ci_status", "view_review_feedback"],
  });

  const changesRequested = await queue.projectReviewState(task.id, {
    outcome: "changes_requested",
    summary: "Please update the parser.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:30:00.000Z",
  });

  assert.equal(changesRequested?.outcome, "changes_requested_transition");
  assert.deepEqual(changesRequested?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_changes_requested");
  assert.equal(eventStore.events.at(-1)?.data.affectedAgentId, "agt_runner");

  const approved = await queue.projectReviewState(task.id, {
    outcome: "approved",
    summary: "Approved.",
    reviewer: "reviewer",
    updatedAt: "2026-05-12T09:45:00.000Z",
    decisionScope: "pull_request",
  });

  assert.equal(approved?.outcome, "approved_transition");
  assert.deepEqual(approved?.task.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_approved");
});

test("projectReviewState does not clear requested changes from a single approval event", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const task = queue.createTask({
    identifier: "REVIEW-SCOPE-1",
    title: "Review scope transition",
    description: "Exercise single-review versus pull-request-wide review decisions.",
    status: "in_review",
    assignee: { id: "agt_runner", name: "Runner" },
    assigneeAgentId: "agt_runner",
    availableActions: ["fix", "view_ci_status", "view_review_feedback"],
    reviewOutcome: "changes_requested",
    ciStatus: "passed",
  });

  const singleApproval = await queue.projectReviewState(task.id, {
    outcome: "approved",
    summary: "Looks good to me.",
    reviewer: "other-reviewer",
    updatedAt: "2026-05-12T09:45:00.000Z",
    decisionScope: "event",
  });

  assert.equal(singleApproval?.outcome, "unchanged");
  assert.equal(singleApproval?.task.reviewOutcome, "changes_requested");
  assert.deepEqual(singleApproval?.task.availableActions, ["fix", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.length, 0);

  const pullRequestApproval = await queue.projectReviewState(task.id, {
    outcome: "approved",
    summary: "All blocking review threads are resolved.",
    reviewer: "github",
    updatedAt: "2026-05-12T09:50:00.000Z",
    decisionScope: "pull_request",
  });

  assert.equal(pullRequestApproval?.outcome, "approved_transition");
  assert.equal(pullRequestApproval?.task.reviewOutcome, "approved");
  assert.deepEqual(pullRequestApproval?.task.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  assert.equal(eventStore.events.at(-1)?.type, "task.review_approved");
});

test("routing intake emits task.updated when a new assigned task becomes startable", async () => {
  const eventStore = new TaskEventStore({ now });
  const queue = new AgentTaskQueue({ now, eventStore });
  const routing = new RoutingControlPlane({ now, taskQueue: queue });
  routing.replaceAgentProfile("agt_runner", {
    displayName: "Runner",
    role: "engineer",
    status: "active",
    capabilityTags: ["backend", "api", "tests"],
    ownershipTags: ["integrations"],
    repoAllowlist: ["oxnw/agentrail"],
    maxConcurrentTasks: 1,
    sourceRef: "routing-intake-test",
    changeReason: "Seed routing profile.",
  }, "agt_router");
  routing.replaceRuleSet({
    sourceRef: "routing-intake-test",
    changeReason: "Seed routing rule.",
    rules: [
      {
        id: "rule_runner",
        name: "Runner rule",
        enabled: true,
        priority: 100,
        conditions: {
          repositories: ["oxnw/agentrail"],
          labelsAny: ["event-wake"],
        },
        target: { type: "agent", id: "agt_runner" },
        confidence: 1,
        explanation: "Route event wake tasks to the runner.",
      },
    ],
    classifier: {
      enabled: false,
      provider: "internal-router",
      confidenceThreshold: 0.8,
      maxCandidates: 3,
      fallbackTriageQueueId: "triage_default",
    },
  }, "agt_router", "idemp_routing_intake_rule");

  const decision = await routing.ingestProviderIssue({
    provider: "github",
    providerIssueId: "github:oxnw/agentrail:issues/7001",
    sourceVersion: "routing-intake-test:001",
    repository: {
      provider: "github",
      owner: "oxnw",
      name: "agentrail",
      defaultBranch: "main",
    },
    title: "Wake from routing intake",
    bodyDigest: "sha256:routing-intake",
    labels: ["event-wake"],
    issueType: "bug",
    priority: "high",
    ownershipTags: ["integrations"],
    capabilityTags: ["backend", "api", "tests"],
    links: {
      providerIssue: "https://github.com/oxnw/agentrail/issues/7001",
    },
  }, "idemp_routing_intake");

  const event = eventStore.events.at(-1);
  assert.equal(decision.outcome, "assigned");
  assert.ok(decision.taskId);
  assert.equal(event?.type, "task.updated");
  assert.equal(event?.data.taskId, decision.taskId);
  assert.equal(event?.data.status, "todo");
  assert.equal(event?.data.previousStatus, null);
  assert.deepEqual(event?.data.availableActions, ["start"]);
  assert.equal(event?.data.affectedAgentId, "agt_runner");
});

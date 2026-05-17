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

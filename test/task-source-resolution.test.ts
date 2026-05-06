import test from "node:test";
import assert from "node:assert/strict";

import { resolveTaskSource } from "../src/task-source-resolution.ts";
import type { TaskRecord } from "../src/task-store.ts";

function makeTask(partial: Partial<TaskRecord> & { id: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: partial.id,
    identifier: partial.identifier ?? "TST-1",
    title: partial.title ?? "Test Task",
    description: partial.description ?? "",
    status: partial.status ?? "in_progress",
    priority: partial.priority ?? "medium",
    assignee: partial.assignee ?? { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    links: partial.links ?? { issue: "" },
    context: partial.context ?? { project: null, goal: "test" },
    updatedAt: partial.updatedAt ?? now,
    availableActions: partial.availableActions ?? ["submit"],
    submissions: partial.submissions ?? [],
    latestSubmissionId: partial.latestSubmissionId ?? null,
    ciStatus: partial.ciStatus ?? null,
    reviewOutcome: partial.reviewOutcome ?? null,
    shipOperation: partial.shipOperation ?? null,
    rollbackOperation: partial.rollbackOperation ?? null,
    dueAt: partial.dueAt ?? null,
    createdAt: partial.createdAt ?? now,
    version: partial.version ?? 1,
    source: partial.source,
  };
}

test("resolveTaskSource returns null when nothing is available", () => {
  const source = resolveTaskSource("tsk_unknown", { getTask: () => null });
  assert.equal(source, null);
});

test("resolveTaskSource returns persisted task source", () => {
  const task = makeTask({
    id: "tsk_1",
    source: { provider: "github", owner: "acme", repo: "webapp", branch: "feat/new" },
  });
  const source = resolveTaskSource("tsk_1", { getTask: () => task });
  assert.deepEqual(source, { provider: "github", owner: "acme", repo: "webapp", branch: "feat/new" });
});

test("resolveTaskSource falls back branch/baseBranch/headSha from latest submission when missing in persisted source", () => {
  const task = makeTask({
    id: "tsk_1",
    source: { provider: "github", owner: "acme", repo: "webapp" },
    submissions: [
      {
        id: "sub_1",
        summary: "Initial PR",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        prNumber: 42,
        prUrl: "https://github.com/acme/webapp/pull/42",
        branch: "feat/submit",
        baseBranch: "main",
        headSha: "abc123",
      },
    ],
    latestSubmissionId: "sub_1",
  });
  const source = resolveTaskSource("tsk_1", { getTask: () => task });
  assert.equal(source?.branch, "feat/submit");
  assert.equal(source?.baseBranch, "main");
  assert.equal(source?.headSha, "abc123");
  assert.equal(source?.pullNumber, 42);
  assert.equal(source?.prUrl, "https://github.com/acme/webapp/pull/42");
});

test("resolveTaskSource returns null for submission-only task metadata", () => {
  const task = makeTask({
    id: "tsk_1",
    submissions: [
      {
        id: "sub_1",
        summary: "Initial PR",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        prNumber: 42,
        prUrl: "https://github.com/acme/webapp/pull/42",
        branch: "feat/submit",
        baseBranch: "main",
        headSha: "abc123",
      },
    ],
    latestSubmissionId: "sub_1",
  });

  const source = resolveTaskSource("tsk_1", { getTask: () => task });

  assert.equal(source, null);
});

test("resolveTaskSource prefers persisted source branch over submission branch", () => {
  const task = makeTask({
    id: "tsk_1",
    source: { provider: "github", owner: "acme", repo: "webapp", branch: "persisted-branch" },
    submissions: [
      {
        id: "sub_1",
        summary: "Initial PR",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        branch: "submission-branch",
      },
    ],
    latestSubmissionId: "sub_1",
  });
  const source = resolveTaskSource("tsk_1", { getTask: () => task });
  assert.equal(source?.branch, "persisted-branch");
});

test("resolveTaskSource resolves pullNumber from submission when missing in persisted source", () => {
  const task = makeTask({
    id: "tsk_1",
    source: { provider: "github", owner: "acme", repo: "webapp" },
    submissions: [
      {
        id: "sub_1",
        summary: "Fix bug",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        prNumber: 99,
      },
    ],
    latestSubmissionId: "sub_1",
  });
  const source = resolveTaskSource("tsk_1", { getTask: () => task });
  assert.equal(source?.pullNumber, 99);
});

test("resolveTaskSource handles malformed/missing task state gracefully", () => {
  const source = resolveTaskSource("tsk_missing", { getTask: () => null });
  assert.equal(source, null);
});

// --- Adapter-level integration tests ---

test("GitHubActionsCiAdapter resolves CI source from persisted task state", async () => {
  const { GitHubActionsCiAdapter } = await import("../src/github-actions-ci-adapter.ts");
  
  const task = makeTask({
    id: "tsk_ci",
    source: { provider: "github", owner: "acme", repo: "webapp", branch: "feat/ci" },
    submissions: [
      {
        id: "sub_ci",
        summary: "CI test",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        prNumber: 7,
        branch: "feat/ci",
        baseBranch: "main",
        headSha: "shaabc",
      },
    ],
    latestSubmissionId: "sub_ci",
  });

  const calls: { url: string }[] = [];
  const mockFetch = (url: string) => {
    calls.push({ url });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ workflow_runs: [] }),
      text: () => Promise.resolve(""),
    } as Response);
  };

  const adapter = new GitHubActionsCiAdapter({
    getTask: () => task,
    githubToken: "test-token",
    fetch: mockFetch as any,
  });

  const result = await adapter.getTaskCiStatus("tsk_ci");
  
  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/repos/acme/webapp/actions/runs"));
  assert.ok(calls[0].url.includes("branch=feat%2Fci"));
});

test("GitHubReviewFeedbackAdapter resolves pullNumber from persisted task submissions", async () => {
  const { GitHubReviewFeedbackAdapter } = await import("../src/github-review-feedback-adapter.ts");

  const task = makeTask({
    id: "tsk_review",
    source: { provider: "github", owner: "acme", repo: "webapp" },
    submissions: [
      {
        id: "sub_review",
        summary: "Review test",
        artifacts: [],
        checks: [],
        notes: null,
        submittedAt: "2026-05-05T12:00:00Z",
        prNumber: 13,
      },
    ],
    latestSubmissionId: "sub_review",
  });

  const calls: { url: string }[] = [];
  const mockFetch = (url: string) => {
    calls.push({ url });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(""),
    } as Response);
  };

  const adapter = new GitHubReviewFeedbackAdapter({
    getTask: () => task,
    githubToken: "test-token",
    fetch: mockFetch as any,
  });

  const result = await adapter.getTaskReviewFeedback("tsk_review");

  assert.ok(result);
  assert.equal(calls.length, 3);
  
  // all calls should reference the resolved pullNumber (13) for reviews, comments, or issue comments
  for (const call of calls) {
    assert.ok(
      /\/pulls\/13\//.test(call.url) || /\/issues\/13\/comments/.test(call.url),
      `Expected URL to reference PR/issue 13, got: ${call.url}`
    );
  }
});

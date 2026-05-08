import assert from "node:assert/strict";
import test from "node:test";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskLifecycleError } from "../src/task-lifecycle-errors.ts";
import { mergeTaskSource, validateTaskSourceRepairRequest } from "../src/task-source-repair.ts";

test("validateTaskSourceRepairRequest rejects unknown fields", () => {
  assert.throws(
    () =>
      validateTaskSourceRepairRequest({
        sourceRef: "operator-test",
        changeReason: "backfill",
        source: { provider: "github", nope: "bad" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof TaskLifecycleError);
      assert.equal(error.code, "validation_error");
      return true;
    },
  );
});

test("validateTaskSourceRepairRequest rejects mixed provider-specific source fields", () => {
  assert.throws(
    () =>
      validateTaskSourceRepairRequest({
        sourceRef: "operator-test",
        changeReason: "backfill",
        source: {
          provider: "linear",
          linearIssueId: "lin_issue_123",
          owner: "acme",
          repo: "web",
        },
      }),
    /Linear task sources cannot include repo field `owner`/,
  );
});

test("validateTaskSourceRepairRequest rejects Linear with repo field", () => {
  assert.throws(
    () =>
      validateTaskSourceRepairRequest({
        sourceRef: "operator-test",
        changeReason: "backfill",
        source: {
          provider: "linear",
          linearIssueId: "lin_issue_123",
          repo: "web",
        },
      }),
    /Linear task sources cannot include repo field `repo`/,
  );
});

test("validateTaskSourceRepairRequest rejects unsupported providers", () => {
  assert.throws(
    () =>
      validateTaskSourceRepairRequest({
        sourceRef: "operator-test",
        changeReason: "backfill",
        source: {
          provider: "jira",
        },
      }),
    /provider `jira` is not supported/i,
  );
});

test("mergeTaskSource applies patch semantics and preserves provider", () => {
  const merged = mergeTaskSource({
    currentSource: {
      provider: "github",
      owner: "acme",
      repo: "web",
      branch: "feature/old",
      reviewers: ["alice"],
    },
    patch: {
      branch: "feature/new",
      reviewers: ["bob"],
      headSha: "abc123",
      prUrl: null,
    },
  });

  assert.deepEqual(merged, {
    provider: "github",
    owner: "acme",
    repo: "web",
    branch: "feature/new",
    reviewers: ["bob"],
    headSha: "abc123",
  });
});

test("mergeTaskSource rejects mixed Linear and repo-backed fields after provider changes", () => {
  assert.throws(
    () =>
      mergeTaskSource({
        currentSource: {
          provider: "github",
          owner: "acme",
          repo: "web",
        },
        patch: {
          provider: "linear",
          linearIssueId: "lin_issue_999",
        },
      }),
    /Linear task sources cannot include repo field `owner`/,
  );
});

test("AgentTaskQueue.repairTaskSource updates persisted task source and replays idempotently", () => {
  const now = () => new Date("2026-05-06T12:00:00Z");
  const queue = new AgentTaskQueue({ now });
  const created = queue.createTask({
    identifier: "AGEA-130",
    title: "Backfill task source",
    description: "Repair persisted provider metadata.",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: [],
    links: { issue: "https://github.com/acme/web/issues/130" },
    context: { project: "acme/web", goal: "repair task source" },
    availableActions: ["submit"],
    source: {
      provider: "github",
      owner: "acme",
      repo: "web",
      branch: "feature/original",
    },
  });

  const first = queue.repairTaskSource(
    created.id,
    {
      sourceRef: "operator-manual-repair",
      changeReason: "backfill PR metadata",
      source: {
        pullNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
        reviewers: ["alice"],
      },
    },
    "agt_operator",
    "repair-001",
  );

  assert.equal(first.data.source.pullNumber, 42);
  assert.equal(first.data.sourceAudit.updatedBy, "agt_operator");
  assert.equal(first.data.sourceAudit.sourceRef, "operator-manual-repair");

  const stored = queue.getRawTask(created.id);
  assert.equal(stored?.source?.prUrl, "https://github.com/acme/web/pull/42");
  assert.deepEqual(stored?.source?.reviewers, ["alice"]);

  const replay = queue.repairTaskSource(
    created.id,
    {
      sourceRef: "operator-manual-repair",
      changeReason: "backfill PR metadata",
      source: {
        pullNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
        reviewers: ["alice"],
      },
    },
    "agt_operator",
    "repair-001",
  );

  assert.deepEqual(replay, first);
});

test("AgentTaskQueue.repairTaskSource rejects mismatched idempotent replay", () => {
  const queue = new AgentTaskQueue();
  const created = queue.createTask({
    identifier: "AGEA-131",
    title: "Detect conflicting repair replay",
    description: "Idempotency collision should fail.",
    status: "in_progress",
    priority: "high",
    assignee: { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: [],
    links: { issue: "https://github.com/acme/web/issues/131" },
    context: { project: "acme/web", goal: "repair task source" },
    availableActions: ["submit"],
    source: {
      provider: "github",
      owner: "acme",
      repo: "web",
    },
  });

  queue.repairTaskSource(
    created.id,
    {
      sourceRef: "operator-manual-repair",
      changeReason: "set branch",
      source: { branch: "feature/one" },
    },
    "agt_operator",
    "repair-002",
  );

  assert.throws(
    () =>
      queue.repairTaskSource(
        created.id,
        {
          sourceRef: "operator-manual-repair",
          changeReason: "set branch differently",
          source: { branch: "feature/two" },
        },
        "agt_operator",
        "repair-002",
      ),
    (error: unknown) => {
      assert.ok(error instanceof TaskLifecycleError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});

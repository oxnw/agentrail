import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { TaskStore, type TaskRecord } from "../src/task-store.ts";

const FIXTURE_NOW = new Date("2026-05-01T03:25:15Z");
const now = () => FIXTURE_NOW;

function makeTask(partial: Partial<Parameters<TaskStore["createTask"]>[0]> & { identifier: string; title: string }) {
  return {
    identifier: partial.identifier,
    title: partial.title,
    description: partial.description ?? "test",
    status: partial.status ?? "in_progress",
    priority: partial.priority ?? "medium",
    assignee: partial.assignee ?? { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    links: partial.links ?? { issue: "https://example.com/issue/1" },
    context: partial.context ?? { project: null, goal: "test" },
    availableActions: partial.availableActions ?? ["submit"],
    ...partial,
  };
}

function makePersistedTask(
  partial: Partial<TaskRecord> & { id: string; identifier: string; title: string }
): TaskRecord {
  const task: TaskRecord = {
    id: partial.id,
    identifier: partial.identifier,
    title: partial.title,
    description: partial.description ?? "test",
    status: partial.status ?? "in_progress",
    priority: partial.priority ?? "medium",
    assignee: partial.assignee ?? { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    links: partial.links ?? { issue: "https://example.com/issue/1" },
    context: partial.context ?? { project: null, goal: "test" },
    updatedAt: partial.updatedAt ?? FIXTURE_NOW.toISOString(),
    availableActions: partial.availableActions ?? ["submit"],
    submissions: partial.submissions ?? [],
    latestSubmissionId: partial.latestSubmissionId ?? null,
    ciStatus: partial.ciStatus ?? null,
    blocker: partial.blocker ?? null,
    reviewOutcome: partial.reviewOutcome ?? null,
    shipOperation: partial.shipOperation ?? null,
    rollbackOperation: partial.rollbackOperation ?? null,
    dueAt: partial.dueAt ?? null,
    createdAt: partial.createdAt ?? FIXTURE_NOW.toISOString(),
    version: partial.version ?? 1,
  };

  if (partial.source !== undefined) {
    task.source = partial.source;
  }
  if (partial.assignmentSource !== undefined) {
    task.assignmentSource = partial.assignmentSource;
  }

  return task;
}

test("TaskStore persists and resumes tasks across instances", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");

  const firstStore = new TaskStore({ now, storagePath });
  const created = firstStore.createTask(makeTask({ identifier: "AGEA-97", title: "Implement durable live task store" }));
  assert.equal(created.identifier, "AGEA-97");
  assert.ok(created.id.startsWith("tsk_"));
  assert.equal(created.version, 1);

  const secondStore = new TaskStore({ now, storagePath });
  const resumed = secondStore.getTask(created.id);
  assert.ok(resumed);
  assert.equal(resumed?.title, "Implement durable live task store");
  assert.equal(resumed?.status, "in_progress");

  await rm(tempDir, { recursive: true, force: true });
});

test("TaskStore migrates legacy single-record JSONL files and rewrites them in state-object format", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");
  const legacyTask = makePersistedTask({
    id: "tsk_legacy_single",
    identifier: "AGEA-97",
    title: "Legacy single-record task",
  });

  try {
    await writeFile(storagePath, JSON.stringify(legacyTask) + "\n", "utf8");

    const store = new TaskStore({ now, storagePath });
    const restored = store.getTask(legacyTask.id);
    assert.deepEqual(restored, { ...legacyTask, source: undefined });

    store.persist();
    const rewritten = JSON.parse(await readFile(storagePath, "utf8"));
    assert.deepEqual(rewritten, {
      tasks: [legacyTask],
      idempotencyEntries: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TaskStore migrates legacy multi-record JSONL files and preserves all tasks on rewrite", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");
  const legacyTasks = [
    makePersistedTask({
      id: "tsk_legacy_multi_1",
      identifier: "AGEA-98",
      title: "Legacy multi-record task one",
    }),
    makePersistedTask({
      id: "tsk_legacy_multi_2",
      identifier: "AGEA-99",
      title: "Legacy multi-record task two",
      updatedAt: "2026-05-01T03:25:16.000Z",
      createdAt: "2026-05-01T03:25:16.000Z",
    }),
  ];

  try {
    await writeFile(storagePath, legacyTasks.map((task) => JSON.stringify(task)).join("\n") + "\n", "utf8");

    const store = new TaskStore({ now, storagePath });
    assert.deepEqual(store.getTask(legacyTasks[0].id), { ...legacyTasks[0], source: undefined });
    assert.deepEqual(store.getTask(legacyTasks[1].id), { ...legacyTasks[1], source: undefined });

    store.persist();
    const rewritten = JSON.parse(await readFile(storagePath, "utf8"));
    assert.deepEqual(rewritten, {
      tasks: legacyTasks,
      idempotencyEntries: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TaskStore normalizes legacy provider assignee assignment sources on load", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");
  const legacyTask = {
    ...makePersistedTask({
      id: "tsk_legacy_provider_assignment",
      identifier: "AGEA-101",
      title: "Legacy provider assignment source",
    }),
    assignmentSource: "provider_assignee_mapping",
  };

  try {
    await writeFile(storagePath, JSON.stringify({
      tasks: [legacyTask],
      idempotencyEntries: [],
    }) + "\n", "utf8");

    const store = new TaskStore({ now, storagePath });
    const restored = store.getTask(legacyTask.id);
    assert.equal(restored?.assignmentSource, "deterministic_rule");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TaskStore rejects legacy task records whose description is not a string", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");
  const invalidLegacyTask = {
    ...makePersistedTask({
      id: "tsk_invalid_legacy",
      identifier: "AGEA-100",
      title: "Invalid legacy task",
    }),
    description: { markdown: "not allowed" },
  };

  try {
    await writeFile(storagePath, JSON.stringify(invalidLegacyTask) + "\n", "utf8");

    assert.throws(
      () => new TaskStore({ now, storagePath }),
      /Unsupported TaskStore state format/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TaskStore supports per-agent filtering", async () => {
  const store = new TaskStore({ now });
  const t1 = store.createTask(makeTask({ identifier: "A-1", title: "Alpha", assignee: { id: "agt_alice", name: "Alice" } }));
  const t2 = store.createTask(makeTask({ identifier: "A-2", title: "Beta", assignee: { id: "agt_bob", name: "Bob" } }));

  const aliceTasks = store.listTasks({ assigneeAgentId: "agt_alice" });
  assert.equal(aliceTasks.data.length, 1);
  assert.equal(aliceTasks.data[0].id, t1.id);

  const bobTasks = store.listTasks({ assigneeAgentId: "agt_bob" });
  assert.equal(bobTasks.data.length, 1);
  assert.equal(bobTasks.data[0].id, t2.id);
});

test("TaskStore filters by canonical assigneeAgentId instead of display assignee id", async () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({
    identifier: "A-3",
    title: "Canonical assignment",
    assignee: { id: "github-login", name: "GitHub Login" },
    assigneeAgentId: "agt_alice",
  }));

  const aliceTasks = store.listTasks({ assigneeAgentId: "agt_alice" });
  assert.equal(aliceTasks.data.length, 1);
  assert.equal(aliceTasks.data[0].id, task.id);

  const githubLoginTasks = store.listTasks({ assigneeAgentId: "github-login" });
  assert.equal(githubLoginTasks.data.length, 0);
});

test("TaskStore supports status filtering", () => {
  const store = new TaskStore({ now });
  store.createTask(makeTask({ identifier: "S-1", title: "Todo task", status: "todo" }));
  store.createTask(makeTask({ identifier: "S-2", title: "In-progress task", status: "in_progress" }));

  const todo = store.listTasks({ status: "todo" });
  assert.equal(todo.data.length, 1);
  assert.equal(todo.data[0].status, "todo");

  const all = store.listTasks();
  assert.equal(all.data.length, 2);
});

test("TaskStore creates tasks with nullable blocker and includes it in summaries", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "B-1", title: "No blocker" }));

  assert.equal(task.blocker, null);
  assert.equal(store.getTask(task.id)?.blocker, null);
  assert.equal(store.listTasks().data[0].blocker, null);
});

test("TaskStore persists and reloads structured awaiting-user blockers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-taskstore-blocker-"));
  const storagePath = path.join(tempDir, "tasks.ndjson");
  const blocker = {
    kind: "awaiting_user" as const,
    sourceRunId: "run_123",
    sourceAgentId: "agt_claudia",
    reason: "Missing credentials",
    actionRequired: "Add the GitHub token",
    resumeInstructions: "Resume the run after the token is configured.",
    createdAt: "2026-05-01T03:26:00.000Z",
  };

  try {
    const firstStore = new TaskStore({ now, storagePath });
    const task = firstStore.createTask(makeTask({
      identifier: "B-2",
      title: "Blocked task",
      status: "blocked",
      availableActions: ["resolve_blocker"],
      blocker,
    }));

    const secondStore = new TaskStore({ now, storagePath });
    assert.deepEqual(secondStore.getTask(task.id)?.blocker, blocker);
    assert.deepEqual(secondStore.listTasks().data[0].blocker, blocker);
    assert.deepEqual(secondStore.listTasks().data[0].availableActions, ["resolve_blocker"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("TaskStore validates and clears structured awaiting-user blockers on update", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "B-3", title: "Update blocker" }));
  const blocker = {
    kind: "awaiting_user" as const,
    sourceRunId: "  run_456  ",
    sourceAgentId: "  agt_claudia  ",
    reason: "  Missing credentials  ",
    actionRequired: "  Add the GitHub token  ",
    resumeInstructions: "  Resume after setup  ",
    createdAt: "  2026-05-01T03:26:00.000Z  ",
  };

  const blocked = store.updateTask(task.id, { status: "blocked", blocker });
  assert.deepEqual(blocked?.blocker, {
    kind: "awaiting_user",
    sourceRunId: "run_456",
    sourceAgentId: "agt_claudia",
    reason: "Missing credentials",
    actionRequired: "Add the GitHub token",
    resumeInstructions: "Resume after setup",
    createdAt: "2026-05-01T03:26:00.000Z",
  });

  const cleared = store.updateTask(task.id, { status: "todo", blocker: null });
  assert.equal(cleared?.blocker, null);
});

test("TaskStore task summaries clone blocker metadata", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({
    identifier: "B-4",
    title: "Summary blocker clone",
    status: "blocked",
    blocker: {
      kind: "awaiting_user",
      sourceRunId: "run_789",
      sourceAgentId: "agt_claudia",
      reason: "Missing credentials",
      actionRequired: "Add the GitHub token",
      resumeInstructions: "Resume after setup",
      createdAt: "2026-05-01T03:26:00.000Z",
    },
  }));

  const summary = store.listTasks().data[0];
  assert.ok(summary.blocker);
  summary.blocker!.reason = "Mutated outside store";

  assert.equal(store.getTask(task.id)?.blocker?.reason, "Missing credentials");
});

test("TaskStore rejects malformed awaiting-user blockers", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "B-5", title: "Invalid blocker" }));

  assert.throws(
    () => store.updateTask(task.id, {
      blocker: {
        kind: "awaiting_user",
        sourceRunId: "run_789",
        sourceAgentId: "agt_claudia",
        reason: "Missing credentials",
        actionRequired: "   ",
        resumeInstructions: "Resume after setup",
        createdAt: "2026-05-01T03:26:00.000Z",
      },
    }),
    /actionRequired/,
  );
  assert.throws(
    () => store.updateTask(task.id, {
      blocker: {
        kind: "awaiting_user",
        sourceRunId: "run_bad_date",
        sourceAgentId: "agt_claudia",
        reason: "Missing credentials",
        actionRequired: "Add the GitHub token",
        resumeInstructions: "Resume after setup",
        createdAt: "not-a-date",
      },
    }),
    /createdAt/,
  );
});

test("TaskStore supports pagination", () => {
  const store = new TaskStore({ now });
  for (let i = 0; i < 5; i++) {
    store.createTask(makeTask({ identifier: `P-${i}`, title: `Task ${i}` }));
  }

  const page1 = store.listTasks({ limit: 2 });
  assert.equal(page1.data.length, 2);
  assert.ok(page1.page.hasMore);
  assert.ok(page1.page.nextCursor);

  const page2 = store.listTasks({ limit: 2, cursor: page1.page.nextCursor });
  assert.equal(page2.data.length, 2);
  assert.ok(page2.page.hasMore);

  const page3 = store.listTasks({ limit: 2, cursor: page2.page.nextCursor });
  assert.equal(page3.data.length, 1);
  assert.equal(page3.page.hasMore, false);
});

test("TaskStore updateTask increments version and updates updatedAt", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "U-1", title: "Before" }));
  const updated = store.updateTask(task.id, { title: "After" });
  assert.ok(updated);
  assert.equal(updated?.title, "After");
  assert.equal(updated?.version, 2);
});

test("TaskStore deleteTask removes records", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "D-1", title: "Delete me" }));
  assert.ok(store.getTask(task.id));
  assert.equal(store.deleteTask(task.id), true);
  assert.equal(store.getTask(task.id), null);
  assert.equal(store.deleteTask(task.id), false);
});

test("TaskStore getTask returns deep clone", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({ identifier: "C-1", title: "Clone test" }));
  const clone = store.getTask(task.id);
  assert.ok(clone);
  clone!.title = "Mutated";
  const refetch = store.getTask(task.id);
  assert.equal(refetch?.title, "Clone test");
});

test("TaskStore keeps ciStatus synchronized with ci.overallStatus", () => {
  const store = new TaskStore({ now });
  const ci = {
    provider: "github",
    overallStatus: "failed" as const,
    blocking: true,
    summary: {
      total: 1,
      passed: 0,
      failed: 1,
      running: 0,
      queued: 0,
      cancelled: 0,
      skipped: 0,
      neutral: 0,
    },
    headline: "Unit tests failed",
    updatedAt: FIXTURE_NOW.toISOString(),
    lastTransitionAt: FIXTURE_NOW.toISOString(),
  };

  const created = store.createTask(makeTask({
    identifier: "CI-1",
    title: "CI mirror",
    ci,
  }));
  assert.equal(created.ciStatus, "failed");

  const updated = store.updateTask(created.id, {
    ciStatus: "passed",
    ci: {
      ...ci,
      overallStatus: "passed",
      blocking: false,
      headline: "Unit tests passed",
    },
  });
  assert.equal(updated?.ciStatus, "passed");
  assert.equal(updated?.ci?.overallStatus, "passed");
});

test("TaskStore rejects mismatched ciStatus and ci.overallStatus", () => {
  const store = new TaskStore({ now });
  assert.throws(
    () => store.createTask(makeTask({
      identifier: "CI-2",
      title: "CI mismatch",
      ciStatus: "passed",
      ci: {
        provider: "github",
        overallStatus: "failed",
        blocking: true,
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          running: 0,
          queued: 0,
          cancelled: 0,
          skipped: 0,
          neutral: 0,
        },
        headline: "Unit tests failed",
        updatedAt: FIXTURE_NOW.toISOString(),
        lastTransitionAt: FIXTURE_NOW.toISOString(),
      },
    })),
    /ciStatus .* must match ci\.overallStatus/,
  );
});

test("TaskStore rejects mismatched ciStatus and ci.overallStatus on update", () => {
  const store = new TaskStore({ now });
  const task = store.createTask(makeTask({
    identifier: "CI-5",
    title: "CI update mismatch",
  }));

  assert.throws(
    () => store.updateTask(task.id, {
      ciStatus: "passed",
      ci: {
        provider: "github",
        overallStatus: "failed",
        blocking: true,
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          running: 0,
          queued: 0,
          cancelled: 0,
          skipped: 0,
          neutral: 0,
        },
        headline: "Unit tests failed",
        updatedAt: FIXTURE_NOW.toISOString(),
        lastTransitionAt: FIXTURE_NOW.toISOString(),
      },
    }),
    /ciStatus .* must match ci\.overallStatus/,
  );
});

test("TaskStore validates ciStatus and ci.overallStatus on upsert", () => {
  const store = new TaskStore({ now });
  const created = store.createTask(makeTask({
    identifier: "CI-3",
    title: "CI upsert mismatch",
  }));

  assert.throws(
    () => store.upsertTask({
      ...created,
      ciStatus: "passed",
      ci: {
        provider: "github",
        overallStatus: "failed",
        blocking: true,
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          running: 0,
          queued: 0,
          cancelled: 0,
          skipped: 0,
          neutral: 0,
        },
        headline: "Unit tests failed",
        updatedAt: FIXTURE_NOW.toISOString(),
        lastTransitionAt: FIXTURE_NOW.toISOString(),
      },
    }),
    /ciStatus .* must match ci\.overallStatus/,
  );
});

test("TaskStore synchronizes ciStatus from ci.overallStatus on upsert", () => {
  const store = new TaskStore({ now });
  const created = store.createTask(makeTask({
    identifier: "CI-4",
    title: "CI upsert sync",
  }));

  const upserted = store.upsertTask({
    ...created,
    ciStatus: null,
    ci: {
      provider: "github",
      overallStatus: "failed",
      blocking: true,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        running: 0,
        queued: 0,
        cancelled: 0,
        skipped: 0,
        neutral: 0,
      },
      headline: "Unit tests failed",
      updatedAt: FIXTURE_NOW.toISOString(),
      lastTransitionAt: FIXTURE_NOW.toISOString(),
    },
  });

  assert.equal(upserted.ciStatus, "failed");
  assert.equal(store.getTask(created.id)?.ciStatus, "failed");
});

test("TaskStore maintains identifier and Linear issue indexes across create, update, and delete", () => {
  const store = new TaskStore({ now });
  const created = store.createTask(makeTask({
    identifier: "linear:agentrail:issues/ENG-1",
    title: "Indexed Linear task",
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_1",
    },
  }));

  assert.equal(store.findTaskByIdentifier("linear:agentrail:issues/ENG-1")?.id, created.id);
  assert.equal(store.findTaskByLinearIssueId("lin_issue_1")?.id, created.id);
  assert.deepEqual(
    store.findTasksByLinearIssueId("lin_issue_1").map((task) => task.id),
    [created.id],
  );

  const updated = store.updateTask(created.id, {
    identifier: "linear:agentrail:issues/ENG-2",
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_2",
    },
  });
  assert.ok(updated);

  assert.equal(store.findTaskByIdentifier("linear:agentrail:issues/ENG-1"), null);
  assert.equal(store.findTaskByLinearIssueId("lin_issue_1"), null);
  assert.deepEqual(store.findTasksByLinearIssueId("lin_issue_1"), []);
  assert.equal(store.findTaskByIdentifier("linear:agentrail:issues/ENG-2")?.id, created.id);
  assert.equal(store.findTaskByLinearIssueId("lin_issue_2")?.id, created.id);
  assert.deepEqual(
    store.findTasksByLinearIssueId("lin_issue_2").map((task) => task.id),
    [created.id],
  );

  assert.equal(store.deleteTask(created.id), true);
  assert.equal(store.findTaskByIdentifier("linear:agentrail:issues/ENG-2"), null);
  assert.equal(store.findTaskByLinearIssueId("lin_issue_2"), null);
  assert.deepEqual(store.findTasksByLinearIssueId("lin_issue_2"), []);
});

test("TaskStore returns the oldest matching task for duplicate Linear issue ids", () => {
  const store = new TaskStore({ now });
  const older = store.createTask(makeTask({
    identifier: "linear:agentrail:issues/ENG-10",
    title: "Older duplicate",
    createdAt: "2026-05-01T03:25:14Z",
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_duplicate",
    },
  }));
  const newer = store.createTask(makeTask({
    identifier: "linear:agentrail:issues/ENG-11",
    title: "Newer duplicate",
    createdAt: "2026-05-01T03:25:16Z",
    source: {
      provider: "linear",
      linearIssueId: "lin_issue_duplicate",
    },
  }));

  const resolved = store.findTaskByLinearIssueId("lin_issue_duplicate");
  assert.equal(resolved?.id, older.id);
  assert.notEqual(resolved?.id, newer.id);
});

test("TaskStore indexes repo-backed tasks by provider owner and repo", () => {
  const store = new TaskStore({ now });
  const first = store.createTask(makeTask({
    identifier: "github:acme/web:issues/1",
    title: "First repo task",
    createdAt: "2026-05-01T03:25:14Z",
    source: {
      provider: "github",
      owner: "acme",
      repo: "web",
      issueNumber: 1,
    },
  }));
  const second = store.createTask(makeTask({
    identifier: "github:acme/web:issues/2",
    title: "Second repo task",
    createdAt: "2026-05-01T03:25:16Z",
    source: {
      provider: "github",
      owner: "acme",
      repo: "web",
      issueNumber: 2,
    },
  }));
  store.createTask(makeTask({
    identifier: "github:acme/other:issues/3",
    title: "Other repo task",
    source: {
      provider: "github",
      owner: "acme",
      repo: "other",
      issueNumber: 3,
    },
  }));

  assert.deepEqual(
    store.findTasksBySourceRepo("github", "acme", "web").map((task) => task.id),
    [first.id, second.id],
  );
});

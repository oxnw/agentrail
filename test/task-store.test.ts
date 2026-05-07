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
    assert.deepEqual(restored, legacyTask);

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
    assert.deepEqual(store.getTask(legacyTasks[0].id), legacyTasks[0]);
    assert.deepEqual(store.getTask(legacyTasks[1].id), legacyTasks[1]);

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

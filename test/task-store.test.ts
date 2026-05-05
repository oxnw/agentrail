import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { TaskStore } from "../src/task-store.ts";

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

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskStore, type TaskRecord } from "../src/task-store.ts";

function createId(): string {
  return `tsk_${crypto.randomBytes(10).toString("hex")}`;
}

function makeTask(partial: Partial<Omit<TaskRecord, "id">> & { identifier: string; title: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: createId(),
    identifier: partial.identifier,
    title: partial.title,
    description: partial.description ?? "",
    status: partial.status ?? "in_progress",
    priority: partial.priority ?? "medium",
    assignee: partial.assignee ?? { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    links: partial.links ?? { issue: "https://example.com/issue/1" },
    context: partial.context ?? { project: null, goal: "test" },
    updatedAt: now,
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
  };
}

function mockDelegate(response: unknown, delay = 0) {
  return {
    submitTask: async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return structuredClone(response);
    },
  };
}

test("AgentTaskQueue.persist - stores idempotency and PR metadata on task record", async () => {
  const now = new Date("2026-05-05T12:00:00Z");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-idem-"));
  const storagePath = path.join(tempDir, "state.json");

  try {
    const queue = new AgentTaskQueue({
      now: () => now,
      storagePath,
      delegate: mockDelegate({
        data: {
          submissionId: "ghpr_123",
          taskId: "TASK_ID",
          status: "in_review",
          prUrl: "https://github.com/acme/webapp/pull/123",
          prNumber: 123,
          action: "created",
          acceptedAt: now.toISOString(),
          availableActions: ["view_review_feedback", "view_ci_status"],
        },
        availableActions: ["view_review_feedback"],
      }),
    });

    const task = queue.createTask(makeTask({ identifier: "AGEA-101", title: "Persist PR metadata" }));

    const result = await queue.submitTask(task.id, { summary: "Fix stuff" }, "idem-101-a");

    // 1. Idempotency entry is persisted
    assert.ok(result);
    const entryKey = "submit:idem-101-a";
    const entry = queue.getIdempotencyEntry(entryKey);
    assert.ok(entry, "idempotency entry should exist");
    assert.equal(entry?.fingerprint, JSON.stringify({ summary: "Fix stuff" }));

    // 2. Task record has metadata
    const updated = queue.getRawTask(task.id);
    assert.ok(updated);
    assert.equal(updated!.status, "in_review");
    assert.equal(updated!.latestSubmissionId, "ghpr_123");
    assert.equal(updated!.submissions.length, 1);
    assert.equal(updated!.submissions[0].prNumber, 123);
    assert.equal(updated!.submissions[0].prUrl, "https://github.com/acme/webapp/pull/123");

    // 3. Second store instance restores state
    const secondQueue = new AgentTaskQueue({
      now: () => now,
      storagePath,
      delegate: mockDelegate({ data: { submissionId: "ghpr_999" } }), // should never be called
    });

    const restoredEntry = secondQueue.getIdempotencyEntry(entryKey);
    assert.ok(restoredEntry, "idempotency entry should survive restart");

    const replay = await secondQueue.submitTask(task.id, { summary: "Fix stuff" }, "idem-101-a");
    assert.equal((replay as any).data.submissionId, "ghpr_123", "should replay without re-delegating");

    // 4. Different payload with same key → 409
    await assert.rejects(
      () => secondQueue.submitTask(task.id, { summary: "Changed" }, "idem-101-a"),
      (err: any) => err.statusCode === 409
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AgentTaskQueue rejects submit without idempotency key", async () => {
  const queue = new AgentTaskQueue({
    delegate: mockDelegate({ data: {} }),
  });

  await assert.rejects(
    () => queue.submitTask("any", {}, undefined),
    (err: any) => err.statusCode === 400
  );
});

test("AgentTaskQueue rejects submit when delegate is missing", async () => {
  const queue = new AgentTaskQueue();

  await assert.rejects(
    () => queue.submitTask("any", {}, "idem-key"),
    (err: any) => err.statusCode === 501
  );
});

test("TaskStore persists idempotency entries across restarts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-store-"));
  const storagePath = path.join(tempDir, "state.json");

  try {
    const store1 = new TaskStore({ storagePath });
    store1.setIdempotencyEntry("key1", { fingerprint: "fp1", response: { ok: true } });

    const store2 = new TaskStore({ storagePath });
    const restored = store2.getIdempotencyEntry("key1");
    assert.ok(restored);
    assert.equal(restored!.fingerprint, "fp1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

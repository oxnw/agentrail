import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { AgentRunStore, type AgentRunStatus } from "../src/agent-run-store.ts";

function makeRun(runId: string, status: AgentRunStatus = "starting") {
  return {
    runId,
    agentId: "agt_claudia",
    runner: "codex",
    taskId: "tsk_123",
    taskIdentifier: "github:oxnw/agentrail:issues/21",
    status,
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    branchName: "agentrail/tsk_123",
    promptPath: "/tmp/prompt.md",
    logPath: "/tmp/run.log",
    handoffPath: null,
    createdAt: "2026-05-09T10:00:00.000Z",
    startedAt: "2026-05-09T10:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-05-09T10:00:01.000Z",
    exitCode: null,
    summary: null,
    userAction: null,
    launch: {
      executable: "codex",
      args: ["exec", "--cd", "/tmp/worktree"],
    },
  };
}

test("AgentRunStore persists and reloads runs", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-"));
  const storagePath = path.join(tempDir, "agent-runs.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const store = new AgentRunStore({
    now: () => new Date("2026-05-09T10:05:00.000Z"),
    storagePath,
  });

  store.createRun(makeRun("run_first", "running"));
  store.updateRun("run_first", {
    status: "succeeded",
    finishedAt: "2026-05-09T10:06:00.000Z",
    exitCode: 0,
    summary: "Completed successfully",
  });

  const reloaded = new AgentRunStore({ storagePath });
  const run = reloaded.getRun("run_first");
  assert.ok(run);
  assert.equal(run.status, "succeeded");
  assert.equal(run.exitCode, 0);
  assert.equal(run.summary, "Completed successfully");

  const persisted = JSON.parse(await readFile(storagePath, "utf8"));
  assert.equal(persisted.runs.length, 1);
});

test("AgentRunStore filters and counts active runs", () => {
  // Active runs are starting/running only; awaiting_user is historical and must not consume capacity.
  const store = new AgentRunStore();
  store.createRun(makeRun("run_active", "running"));
  store.createRun({
    ...makeRun("run_other", "awaiting_user"),
    taskId: "tsk_456",
  });
  store.createRun({
    ...makeRun("run_done", "failed"),
    taskId: "tsk_789",
  });

  assert.equal(store.countActiveRuns("agt_claudia"), 1);
  assert.equal(store.findActiveRunByTask("agt_claudia", "tsk_456"), null);
  assert.equal(store.findActiveRunByTask("agt_claudia", "tsk_789"), null);
  assert.deepEqual(
    store.listRuns({ status: "failed" }).map((run) => run.runId),
    ["run_done"],
  );
});

test("AgentRunStore reclaims orphaned active runs from dead processes", () => {
  const store = new AgentRunStore({
    now: () => new Date("2026-05-18T15:10:00.000Z"),
  });
  store.createRun({
    ...makeRun("run_orphaned", "running"),
    updatedAt: "2026-05-18T15:07:00.000Z",
    launch: {
      executable: "codex",
      args: ["exec"],
      processId: 999999,
    },
  });
  store.createRun({
    ...makeRun("run_live", "running"),
    taskId: "tsk_456",
    updatedAt: "2026-05-18T15:09:45.000Z",
    launch: {
      executable: "codex",
      args: ["exec"],
      processId: process.pid,
    },
  });

  const reclaimed = store.reconcileOrphanedActiveRuns("agt_claudia", {
    currentProcessId: process.pid,
    staleAfterMs: 60_000,
  });

  assert.deepEqual(reclaimed.map((run) => run.runId), ["run_orphaned"]);
  assert.equal(store.getRun("run_orphaned")?.status, "failed");
  assert.equal(store.getRun("run_live")?.status, "running");
  assert.equal(store.countActiveRuns("agt_claudia"), 1);
});

test("AgentRunStore honors zero limit", () => {
  const store = new AgentRunStore();
  store.createRun(makeRun("run_first", "running"));

  assert.deepEqual(store.listRuns({ limit: 0 }), []);
  assert.throws(() => store.listRuns({ limit: -1 }), /non-negative/);
  assert.throws(() => store.listRuns({ limit: 1.5 }), /integer/);
});

test("AgentRunStore records progress reports and reloads external run writes", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-report-"));
  const storagePath = path.join(tempDir, "agent-runs.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const longLivedStore = new AgentRunStore({
    now: () => new Date("2026-05-09T10:07:00.000Z"),
    storagePath,
  });
  // writerStore creates a run that longLivedStore does not have in memory,
  // so reportRun must reload the external createRun write before updating it.
  const writerStore = new AgentRunStore({ storagePath });
  writerStore.createRun(makeRun("run_report", "running"));

  const updated = longLivedStore.reportRun("run_report", {
    status: "progress",
    summary: "Finished the implementation and running tests.",
  });

  assert.ok(updated);
  assert.equal(updated.summary, "Finished the implementation and running tests.");
  assert.equal(updated.reports.length, 1);
  assert.equal(updated.reports[0].status, "progress");
  assert.equal(updated.reports[0].createdAt, "2026-05-09T10:07:00.000Z");

  const reloaded = new AgentRunStore({ storagePath }).getRun("run_report");
  assert.equal(reloaded?.reports[0].summary, "Finished the implementation and running tests.");
});

test("AgentRunStore trims report summaries and can clear reported handoff", () => {
  const store = new AgentRunStore({
    now: () => new Date("2026-05-09T10:08:00.000Z"),
  });
  store.createRun(makeRun("run_handoff", "running"));

  const withHandoff = store.reportRun("run_handoff", {
    status: "blocked",
    summary: "  Needs GitHub token  ",
    reason: "  Missing GitHub token  ",
    actionRequired: "  Add token  ",
    resumeInstructions: "  Re-run after token is configured  ",
    handoff: { target: "user", actionRequired: "Add token" },
  });
  assert.equal(withHandoff?.status, "awaiting_user");
  assert.equal(withHandoff?.summary, "Needs GitHub token");
  assert.equal(withHandoff?.reports[0].summary, "Needs GitHub token");
  assert.deepEqual(withHandoff?.reportedHandoff, { target: "user", actionRequired: "Add token" });
  assert.deepEqual(withHandoff?.userAction, {
    kind: "awaiting_user",
    taskId: "tsk_123",
    reason: "Missing GitHub token",
    actionRequired: "Add token",
    resumeInstructions: "Re-run after token is configured",
    createdAt: "2026-05-09T10:08:00.000Z",
  });

  const cleared = store.reportRun("run_handoff", {
    status: "progress",
    summary: "  Token added  ",
    handoff: null,
  });
  assert.equal(cleared?.summary, "Token added");
  assert.equal(cleared?.reportedHandoff, null);
  assert.deepEqual(cleared?.userAction, withHandoff?.userAction);
});

test("AgentRunStore requires structured user-needed fields for blocked reports", () => {
  const store = new AgentRunStore();
  store.createRun(makeRun("run_blocked_validation", "running"));

  assert.throws(
    () => store.reportRun("run_blocked_validation", {
      status: "blocked",
      summary: "Blocked",
      reason: "Missing token",
      actionRequired: "Add token",
    } as unknown as Parameters<AgentRunStore["reportRun"]>[1]),
    /resumeInstructions/,
  );
  assert.throws(
    () => store.reportRun("run_blocked_validation", {
      status: "blocked",
      summary: "Blocked",
      actionRequired: "Add token",
      resumeInstructions: "Resume after setup.",
    } as unknown as Parameters<AgentRunStore["reportRun"]>[1]),
    /reason/,
  );
  assert.throws(
    () => store.reportRun("run_blocked_validation", {
      status: "blocked",
      summary: "Blocked",
      reason: "Missing token",
      resumeInstructions: "Resume after setup.",
    } as unknown as Parameters<AgentRunStore["reportRun"]>[1]),
    /actionRequired/,
  );
  for (const field of ["reason", "actionRequired", "resumeInstructions"] as const) {
    assert.throws(
      () => store.reportRun("run_blocked_validation", {
        status: "blocked",
        summary: "Blocked",
        reason: "Missing token",
        actionRequired: "Add token",
        resumeInstructions: "Resume after setup.",
        [field]: "   ",
      }),
      new RegExp(field),
    );
  }
  assert.equal(store.getRun("run_blocked_validation")?.status, "running");
  assert.equal(store.getRun("run_blocked_validation")?.reports.length, 0);
});

test("AgentRunStore ignores invalid persisted state", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-invalid-"));
  const storagePath = path.join(tempDir, "agent-runs.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(storagePath, JSON.stringify({
    runs: [
      { runId: "run_bad" },
      makeRun("run_good", "starting"),
    ],
  }), "utf8");

  const store = new AgentRunStore({ storagePath });
  assert.equal(store.getRun("run_bad"), null);
  assert.equal(store.getRun("run_good")?.runId, "run_good");
});

test("AgentRunStore backfills missing nullable userAction on persisted runs", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-missing-user-action-"));
  const storagePath = path.join(tempDir, "agent-runs.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const persistedRun = { ...makeRun("run_missing_user_action", "running") } as Record<string, unknown>;
  delete persistedRun.userAction;
  await writeFile(storagePath, JSON.stringify({ runs: [persistedRun] }), "utf8");

  const store = new AgentRunStore({ storagePath });
  const loaded = store.getRun("run_missing_user_action");
  assert.ok(loaded);
  assert.equal(loaded.userAction, null);
});

test("AgentRunStore handles malformed JSON gracefully", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-run-store-malformed-"));
  const storagePath = path.join(tempDir, "agent-runs.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(storagePath, "{ invalid json }", "utf8");

  const store = new AgentRunStore({ storagePath });
  assert.equal(store.listRuns().length, 0);
  assert.equal(store.getRun("run_missing"), null);
});

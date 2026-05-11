import test from "node:test";
import assert from "node:assert/strict";

import { GitHubRollbackAdapter } from "../src/github-rollback-adapter.ts";
import type { TaskRecord } from "../src/task-store.ts";

function makeTask(partial: Partial<TaskRecord> & { id: string }): TaskRecord {
  const now = "2026-05-05T12:00:00Z";
  return {
    id: partial.id,
    identifier: partial.identifier ?? "AGEA-99",
    title: partial.title ?? "Rollback source test",
    description: partial.description ?? "",
    status: partial.status ?? "done",
    priority: partial.priority ?? "medium",
    assignee: partial.assignee ?? { id: "agt_test", name: "Test Agent" },
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    links: partial.links ?? { issue: "https://github.com/acme/webapp/issues/99" },
    context: partial.context ?? { project: "acme/webapp", goal: "test rollback source resolution" },
    updatedAt: partial.updatedAt ?? now,
    availableActions: partial.availableActions ?? ["rollback"],
    submissions: partial.submissions ?? [],
    latestSubmissionId: partial.latestSubmissionId ?? null,
    ciStatus: partial.ciStatus ?? null,
    blocker: partial.blocker ?? null,
    reviewOutcome: partial.reviewOutcome ?? null,
    shipOperation: partial.shipOperation ?? null,
    rollbackOperation: partial.rollbackOperation ?? null,
    dueAt: partial.dueAt ?? null,
    createdAt: partial.createdAt ?? now,
    version: partial.version ?? 1,
    source: partial.source,
  };
}

test("GitHubRollbackAdapter resolves source from persisted task state", () => {
  const task = makeTask({
    id: "tsk_routed",
    source: {
      provider: "github",
      owner: "acme",
      repo: "webapp",
      baseBranch: "develop",
      issueNumber: 99,
      pullNumber: 10,
    },
  });
  const adapter = new GitHubRollbackAdapter({
    githubToken: "test-token",
    getTask: () => task,
  });

  const source = adapter.lookupTaskSource("tsk_routed");

  assert.equal(source?.owner, "acme");
  assert.equal(source?.repo, "webapp");
  assert.equal(source?.baseBranch, "develop");
  assert.equal(source?.pullNumber, 10);
});

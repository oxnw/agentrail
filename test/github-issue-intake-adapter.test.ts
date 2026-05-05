import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { GitHubIssueIntakeAdapter } from "../src/github-issue-intake-adapter.ts";

describe("GitHubIssueIntakeAdapter", () => {
  const makeQueue = () => new AgentTaskQueue();

  it("ingests a GitHub issue into the task store", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 10,
      issueUrl: "https://github.com/oxnw/agentrail/issues/10",
      issueTitle: "Fix idempotent ship retry handling",
      body: "Implement and verify idempotent retry semantics for the ship endpoint.\n\n## Acceptance Criteria\n- [ ] POST /tasks/{id}/ship is safe to retry.\n- Different payload reuse returns 409 conflict.",
      labels: ["bug", "high-priority"],
      state: "open",
      repository: { owner: "oxnw", repo: "agentrail" },
      assignees: [{ login: "dev-1" }],
    }, "idemp_01");

    assert.ok(result.taskId.startsWith("tsk_"), "taskId should be generated");
    assert.strictEqual(result.identifier, "github:oxnw/agentrail:issues/10");
    assert.strictEqual(result.status, "todo");
    assert.deepStrictEqual(result.availableActions, ["start"]);
    assert.ok(result.createdAt);

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.strictEqual(stored!.title, "Fix idempotent ship retry handling");
    assert.strictEqual(stored!.status, "todo");
    assert.strictEqual(stored!.priority, "high");
    assert.deepStrictEqual(stored!.assignee, { id: "dev-1", name: "dev-1" });
    assert.strictEqual(stored!.links.issue, "https://github.com/oxnw/agentrail/issues/10");
    assert.deepStrictEqual(stored!.acceptanceCriteria, [
      "POST /tasks/{id}/ship is safe to retry.",
      "Different payload reuse returns 409 conflict.",
    ]);
    assert.strictEqual(stored!.source!.provider, "github");
    assert.strictEqual(stored!.source!.owner, "oxnw");
    assert.strictEqual(stored!.source!.repo, "agentrail");
    assert.strictEqual(stored!.source!.issueNumber, 10);
    assert.deepStrictEqual(stored!.source!.labels, ["bug", "high-priority"]);
    assert.deepStrictEqual(stored!.source!.assignees, ["dev-1"]);
    assert.strictEqual(stored!.source!.deliveryId, "idemp_01");
    assert.ok(stored!.source!.receivedAt);
  });

  it("defaults assignee when none provided", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 11,
      issueUrl: "https://github.com/oxnw/agentrail/issues/11",
      issueTitle: "Another issue",
    });

    const stored = queue.getRawTask(result.taskId);
    assert.deepStrictEqual(stored!.assignee, { id: "unknown", name: "Unknown" });
  });

  it("returns validation error when issueNumber is missing", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    await assert.rejects(
      adapter.ingest({ issueNumber: undefined as unknown as number, issueUrl: "https://github.com/oxnw/agentrail/issues/12", issueTitle: "bad" }),
      (err: any) => err.statusCode === 400
    );
  });

  it("maps closed state to done", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 13,
      issueUrl: "https://github.com/oxnw/agentrail/issues/13",
      issueTitle: "Closed issue",
      state: "closed",
    });

    assert.strictEqual(result.status, "done");
  });

  it("infers priority from labels", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const cases = [
      { labels: ["critical"], expected: "critical" },
      { labels: ["p0"], expected: "critical" },
      { labels: ["high", "p1"], expected: "high" },
      { labels: ["low"], expected: "low" },
      { labels: ["p2"], expected: "low" },
      { labels: [], expected: "medium" },
    ];

    for (const { labels, expected } of cases) {
      const result = await adapter.ingest({
        issueNumber: Math.floor(Math.random() * 100000),
        issueUrl: "https://github.com/oxnw/agentrail/issues/99",
        issueTitle: "Priority test",
        labels,
      });
      const stored = queue.getRawTask(result.taskId);
      assert.strictEqual(stored!.priority, expected, `priority for labels ${JSON.stringify(labels)}`);
    }
  });

  it("returns cached result on duplicate replay with same idempotency key", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const first = await adapter.ingest({
      issueNumber: 20,
      issueUrl: "https://github.com/oxnw/agentrail/issues/20",
      issueTitle: "Duplicate test",
      labels: ["bug"],
    }, "idemp_dup");

    const second = await adapter.ingest({
      issueNumber: 20,
      issueUrl: "https://github.com/oxnw/agentrail/issues/20",
      issueTitle: "Duplicate test updated",
      labels: ["feature"],
    }, "idemp_dup");

    // Cached from first request (idempotency key hit)
    assert.strictEqual(second.taskId, first.taskId);
    assert.strictEqual(second.status, first.status);

    // Verify underlying task was NOT updated
    const stored = queue.getRawTask(first.taskId);
    assert.strictEqual(stored!.title, "Duplicate test");
    assert.deepStrictEqual(stored!.source!.labels, ["bug"]);
  });

  it("updates existing task on repeat webhook with different idempotency key", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const first = await adapter.ingest({
      issueNumber: 21,
      issueUrl: "https://github.com/oxnw/agentrail/issues/21",
      issueTitle: "Original title",
      labels: ["bug"],
      state: "open",
      assignees: [{ login: "alice" }],
    }, "idemp_first");

    const second = await adapter.ingest({
      issueNumber: 21,
      issueUrl: "https://github.com/oxnw/agentrail/issues/21",
      issueTitle: "Updated title",
      labels: ["enhancement", "high-priority"],
      state: "closed",
      assignees: [{ login: "bob" }],
    }, "idemp_second");

    // Same task updated
    assert.strictEqual(second.taskId, first.taskId);
    assert.strictEqual(second.status, "done");

    const stored = queue.getRawTask(first.taskId);
    assert.strictEqual(stored!.title, "Updated title");
    assert.strictEqual(stored!.status, "done");
    assert.strictEqual(stored!.priority, "high");
    assert.deepStrictEqual(stored!.assignee, { id: "bob", name: "bob" });
    assert.deepStrictEqual(stored!.source!.labels, ["enhancement", "high-priority"]);
  });

  it("handles malformed payload gracefully", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    await assert.rejects(
      adapter.ingest({ issueNumber: "not-a-number" as unknown as number, issueUrl: "x", issueTitle: "bad" }),
      (err: any) => err.statusCode === 400
    );

    await assert.rejects(
      adapter.ingest({ issueNumber: null as unknown as number, issueUrl: "x", issueTitle: "bad" }),
      (err: any) => err.statusCode === 400
    );
  });

  it("builds identifier from issueUrl when repository is missing", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 30,
      issueUrl: "https://github.com/acme/widgets/issues/30",
      issueTitle: "Missing repo mapping",
    });

    assert.strictEqual(result.identifier, "github:acme/widgets:issues/30");

    const stored = queue.getRawTask(result.taskId);
    assert.strictEqual(stored!.context.project, null);
  });

  it("builds fallback identifier when url is unparseable and no repo", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 99,
      issueUrl: "not-a-url",
      issueTitle: "Fallback",
    });

    assert.strictEqual(result.identifier, "github:issues/99");
  });
});

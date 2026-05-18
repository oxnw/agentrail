import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { GitHubIssueIntakeAdapter } from "../src/github-issue-intake-adapter.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";

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
    assert.deepStrictEqual(stored!.assignee, { id: "unassigned", name: "Unassigned" });
    assert.strictEqual(stored!.assigneeAgentId, null);
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
    assert.strictEqual(stored!.source!.deliveryId, "idemp_01");
    assert.ok(stored!.source!.receivedAt);
  });

  it("defaults assignee to unassigned", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 11,
      issueUrl: "https://github.com/oxnw/agentrail/issues/11",
      issueTitle: "Another issue",
    });

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored, "Task should exist");
    assert.deepStrictEqual(stored!.assignee, { id: "unassigned", name: "Unassigned" });
    assert.strictEqual(stored!.assigneeAgentId, null);
  });

  it("rejects required routing when no active routing rule set exists", async () => {
    const queue = makeQueue();
    const routingControlPlane = new RoutingControlPlane({ taskQueue: queue });
    const adapter = new GitHubIssueIntakeAdapter({
      taskQueue: queue,
      routingControlPlane,
      routingMode: "required",
    });

    await assert.rejects(
      adapter.ingest({
        issueNumber: 12,
        issueUrl: "https://github.com/oxnw/agentrail/issues/12",
        issueTitle: "Requires routing",
        repository: { owner: "oxnw", repo: "agentrail" },
      }, "github-required-no-rules"),
      (err: any) => err.statusCode === 404 && err.code === "not_found",
    );
    assert.strictEqual(queue.listRawTasks().length, 0);
  });

  it("passes bounded issue body preview into routing snapshots", async () => {
    const queue = makeQueue();
    const snapshots: any[] = [];
    const adapter = new GitHubIssueIntakeAdapter({
      taskQueue: queue,
      routingControlPlane: {
        ingestProviderIssue: async (snapshot: any) => {
          snapshots.push(snapshot);
          return { taskId: null };
        },
      } as any,
      routingMode: "required",
      repos: [{ slug: "oxnw/agentrail", defaultBranch: "main" }],
    });

    await adapter.ingest({
      issueNumber: 12,
      issueUrl: "https://github.com/oxnw/agentrail/issues/12",
      issueTitle: "Requires routing",
      body: "Detailed login failure report",
      repository: { owner: "oxnw", repo: "agentrail" },
    }, "github-body-preview");

    assert.strictEqual(snapshots[0].bodyPreview, "Detailed login failure report");
  });

  it("persists CircleCI project metadata from connected repo config onto new GitHub tasks", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({
      taskQueue: queue,
      repos: [{
        slug: "oxnw/agentrail",
        defaultBranch: "main",
        circleciProjectSlug: "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1",
      }],
    });

    const result = await adapter.ingest({
      issueNumber: 14,
      issueUrl: "https://github.com/oxnw/agentrail/issues/14",
      issueTitle: "CircleCI-backed task",
      repository: { owner: "oxnw", repo: "agentrail" },
    });

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.source?.ciProvider, "circleci");
    assert.strictEqual(stored!.source?.projectSlug, "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1");
  });

  it("updates existing GitHub tasks when repo CircleCI metadata is added", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const first = await adapter.ingest({
      issueNumber: 15,
      issueUrl: "https://github.com/oxnw/agentrail/issues/15",
      issueTitle: "Later gains CircleCI config",
      repository: { owner: "oxnw", repo: "agentrail" },
    }, "circleci-metadata-first");

    const withCircleCi = new GitHubIssueIntakeAdapter({
      taskQueue: queue,
      repos: [{
        slug: "oxnw/agentrail",
        defaultBranch: "main",
        circleciProjectSlug: "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1",
      }],
    });

    await withCircleCi.ingest({
      issueNumber: 15,
      issueUrl: "https://github.com/oxnw/agentrail/issues/15",
      issueTitle: "Later gains CircleCI config",
      repository: { owner: "oxnw", repo: "agentrail" },
    }, "circleci-metadata-second");

    const stored = queue.getRawTask(first.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.source?.ciProvider, "circleci");
    assert.strictEqual(stored!.source?.projectSlug, "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1");
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
    const payload = {
      issueNumber: 20,
      issueUrl: "https://github.com/oxnw/agentrail/issues/20",
      issueTitle: "Duplicate test",
      labels: ["bug"],
    };

    const first = await adapter.ingest(payload, "idemp_dup");
    const second = await adapter.ingest(payload, "idemp_dup");

    // Cached from first request (idempotency key hit)
    assert.strictEqual(second.taskId, first.taskId);
    assert.strictEqual(second.status, first.status);
    assert.strictEqual(first.outcome, "created");
    assert.strictEqual(second.outcome, "unchanged");

    // Verify underlying task was NOT updated
    const stored = queue.getRawTask(first.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.title, "Duplicate test");
    assert.deepStrictEqual(stored!.source!.labels, ["bug"]);
  });

  it("rejects a reused idempotency key with a different intake payload", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    await adapter.ingest({
      issueNumber: 20,
      issueUrl: "https://github.com/oxnw/agentrail/issues/20",
      issueTitle: "Duplicate test",
      labels: ["bug"],
    }, "idemp_conflict");

    await assert.rejects(
      adapter.ingest({
        issueNumber: 20,
        issueUrl: "https://github.com/oxnw/agentrail/issues/20",
        issueTitle: "Duplicate test updated",
        labels: ["feature"],
      }, "idemp_conflict"),
      (err: any) => err.statusCode === 409 && err.code === "conflict"
    );
  });

  it("rejects corrupt cached idempotency responses", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });
    const payload = {
      issueNumber: 22,
      issueUrl: "https://github.com/oxnw/agentrail/issues/22",
      issueTitle: "Corrupt cache test",
      labels: ["bug"],
    };

    await adapter.ingest(payload, "idemp_corrupt");
    const cached = queue.getIdempotencyEntry("github-issue-intake:idemp_corrupt");
    assert.ok(cached);
    // A valid cached result includes taskId, identifier, status, createdAt, and availableActions.
    // Replace it with an unrelated object to simulate stale or corrupted persisted idempotency data.
    queue.setIdempotencyEntry("github-issue-intake:idemp_corrupt", {
      fingerprint: cached.fingerprint,
      response: { ok: true },
    });

    await assert.rejects(
      adapter.ingest(payload, "idemp_corrupt"),
      (error) => {
        const lifecycleError = error as { statusCode?: number; code?: string };
        return lifecycleError.statusCode === 500 && lifecycleError.code === "internal_error";
      },
    );
  });

  it("namespaces idempotency keys away from other task operations", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });
    queue.setIdempotencyEntry("setup-verification:agt_setup:v1", {
      fingerprint: "setup",
      response: {
        data: {
          taskId: "tsk_setup",
          taskIdentifier: "LOCAL-SETUP-AGT-SETUP",
        },
      },
    });

    const result = await adapter.ingest({
      issueNumber: 23,
      issueUrl: "https://github.com/oxnw/agentrail/issues/23",
      issueTitle: "Do not replay setup result",
    }, "setup-verification:agt_setup:v1");

    assert.ok(result.taskId.startsWith("tsk_"));
    assert.strictEqual(result.identifier, "github:oxnw/agentrail:issues/23");
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
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.title, "Updated title");
    assert.strictEqual(stored!.status, "done");
    assert.strictEqual(stored!.priority, "high");
    assert.deepStrictEqual(stored!.assignee, { id: "unassigned", name: "Unassigned" });
    assert.strictEqual(stored!.assigneeAgentId, null);
    assert.deepStrictEqual(stored!.source!.labels, ["enhancement", "high-priority"]);
  });

  it("does not demote submitted tasks back to todo on repeat open issue sync", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const first = await adapter.ingest({
      issueNumber: 26,
      issueUrl: "https://github.com/oxnw/agentrail/issues/26",
      issueTitle: "Submitted task",
      labels: ["bug"],
      state: "open",
      repository: { owner: "oxnw", repo: "agentrail" },
      assignees: [{ login: "alice" }],
    }, "idemp_submitted_first");
    queue.updateTask(first.taskId, {
      status: "in_review",
      availableActions: ["ship", "view_ci_status", "view_review_feedback"],
    });

    const second = await adapter.ingest({
      issueNumber: 26,
      issueUrl: "https://github.com/oxnw/agentrail/issues/26",
      issueTitle: "Submitted task with sparse edit",
      state: "open",
      repository: { owner: "oxnw", repo: "agentrail" },
    }, "idemp_submitted_second");

    assert.strictEqual(second.taskId, first.taskId);
    assert.strictEqual(second.status, "in_review");

    const stored = queue.getRawTask(first.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.title, "Submitted task with sparse edit");
    assert.strictEqual(stored!.status, "in_review");
    assert.deepStrictEqual(stored!.availableActions, ["ship", "view_ci_status", "view_review_feedback"]);
  });

  it("classifies identical repeat intake as unchanged", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });
    const payload = {
      issueNumber: 24,
      issueUrl: "https://github.com/oxnw/agentrail/issues/24",
      issueTitle: "No-op repeat",
      body: "No changes here.",
      labels: ["bug"],
      state: "open" as const,
      repository: { owner: "oxnw", repo: "agentrail" },
      assignees: [{ login: "alice" }],
    };

    const first = await adapter.ingest(payload, "idemp_noop_first");
    const second = await adapter.ingest(payload, "idemp_noop_second");

    assert.strictEqual(first.outcome, "created");
    assert.strictEqual(second.outcome, "unchanged");
    assert.strictEqual(second.taskId, first.taskId);

    const stored = queue.getRawTask(second.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.title, "No-op repeat");
    assert.deepStrictEqual(stored!.acceptanceCriteria, []);
    assert.strictEqual(stored!.status, "todo");
    assert.deepStrictEqual(stored!.assignee, { id: "unassigned", name: "Unassigned" });
    assert.strictEqual(stored!.assigneeAgentId, null);
    assert.deepStrictEqual(stored!.source?.labels, ["bug"]);
    assert.strictEqual(stored!.source?.owner, "oxnw");
    assert.strictEqual(stored!.source?.repo, "agentrail");
    assert.strictEqual(stored!.source?.deliveryId, "idemp_noop_first");
  });

  it("updates existing tasks whose legacy record is missing links", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });
    const payload = {
      issueNumber: 25,
      issueUrl: "https://github.com/oxnw/agentrail/issues/25",
      issueTitle: "Legacy links fallback",
      body: "Restore missing task links from the GitHub payload.",
      labels: ["bug"],
      state: "open" as const,
      repository: { owner: "oxnw", repo: "agentrail" },
      assignees: [{ login: "alice" }],
    };

    const first = await adapter.ingest(payload, "idemp_links_first");
    queue.updateTask(first.taskId, { links: undefined });

    const second = await adapter.ingest(payload, "idemp_links_second");

    assert.strictEqual(second.taskId, first.taskId);
    const stored = queue.getRawTask(second.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.links.issue, "https://github.com/oxnw/agentrail/issues/25");
  });

  it("preserves existing task fields when sparse webhook updates omit optional payload fields", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const first = await adapter.ingest({
      issueNumber: 22,
      issueUrl: "https://github.com/oxnw/agentrail/issues/22",
      issueTitle: "Original title",
      body: "Keep the current task details.\n\n## Acceptance Criteria\n- [ ] Preserve existing task state on sparse updates.",
      labels: ["critical"],
      state: "closed",
      repository: { owner: "oxnw", repo: "agentrail" },
      assignees: [{ login: "alice" }],
    }, "idemp_sparse_first");

    await adapter.ingest({
      issueNumber: 22,
      issueUrl: "https://github.com/oxnw/agentrail/issues/22",
      issueTitle: "Edited title only",
    }, "idemp_sparse_second");

    const stored = queue.getRawTask(first.taskId);
    assert.ok(stored, "Task should exist");
    assert.strictEqual(stored!.title, "Edited title only");
    assert.strictEqual(stored!.description, "Keep the current task details.\n\n## Acceptance Criteria\n- [ ] Preserve existing task state on sparse updates.");
    assert.strictEqual(stored!.status, "done");
    assert.strictEqual(stored!.priority, "critical");
    assert.deepStrictEqual(stored!.assignee, { id: "unassigned", name: "Unassigned" });
    assert.deepStrictEqual(stored!.acceptanceCriteria, [
      "Preserve existing task state on sparse updates.",
    ]);
    assert.strictEqual(stored!.context.project, "oxnw/agentrail");
    assert.deepStrictEqual(stored!.source!.labels, ["critical"]);
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
    assert.strictEqual(stored!.context.project, "acme/widgets");
    assert.strictEqual(stored!.source!.owner, "acme");
    assert.strictEqual(stored!.source!.repo, "widgets");
  });

  it("derives owner and repo from GitHub REST API issue urls when repository is missing", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    const result = await adapter.ingest({
      issueNumber: 30,
      issueUrl: "https://api.github.com/repos/acme/widgets/issues/30",
      issueTitle: "Missing repo mapping via API URL",
    });

    assert.strictEqual(result.identifier, "github:acme/widgets:issues/30");

    const stored = queue.getRawTask(result.taskId);
    assert.strictEqual(stored!.context.project, "acme/widgets");
    assert.strictEqual(stored!.source!.owner, "acme");
    assert.strictEqual(stored!.source!.repo, "widgets");
  });

  it("rejects payloads that omit repository context and provide an unparseable issue url", async () => {
    const queue = makeQueue();
    const adapter = new GitHubIssueIntakeAdapter({ taskQueue: queue });

    await assert.rejects(
      adapter.ingest({
        issueNumber: 99,
        issueUrl: "not-a-url",
        issueTitle: "Fallback",
      }),
      (err: any) => err.statusCode === 400
    );
  });
});

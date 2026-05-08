import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";
import { LinearIssueSourceAdapter } from "../src/linear-issue-source-adapter.ts";

describe("LinearIssueSourceAdapter", () => {
  const now = () => new Date("2026-05-06T18:00:00.000Z");
  const makeQueue = () => new AgentTaskQueue({ now });

  const makeLinearIssuePayload = (overrides: Record<string, unknown> = {}) => ({
    id: "lin_issue_routing",
    identifier: "ENG-904",
    url: "https://linear.app/agentrail/issue/ENG-904/routing",
    title: "Route Linear issue",
    description: "Route this issue through AgentRail.",
    state: { id: "state_backlog", name: "Backlog", type: "backlog" },
    team: { id: "team_01", key: "ENG", name: "Engineering" },
    labels: { nodes: [{ name: "integration" }] },
    workspace: { id: "workspace_01", urlKey: "agentrail" },
    ...overrides,
  });

  const seedRoutingRuleSet = (
    routing: RoutingControlPlane,
    rules: Parameters<RoutingControlPlane["replaceRuleSet"]>[0]["rules"],
  ) => {
    routing.replaceRuleSet({
      sourceRef: "issue-21-test",
      changeReason: "seed routing for Linear intake tests",
      rules,
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.82,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_engineering",
      },
    }, "agt_router");
  };

  const seedRoutingProfile = (routing: RoutingControlPlane) => {
    routing.replaceAgentProfile("agt_linear", {
      displayName: "Linear Agent",
      role: "engineer",
      status: "active",
      capabilityTags: ["linear"],
      ownershipTags: ["linear"],
      repoAllowlist: ["agentrail/ENG"],
      maxConcurrentTasks: 5,
      sourceRef: "issue-21-test",
      changeReason: "seed Linear routing agent",
    }, "agt_router");
  };

  const createMockLinearFetch = (
    calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>,
    responseByOperation: {
      commentCreate?: Response;
      issueUpdate?: Response;
      issue?: Response;
    } = {},
  ) => {
    return async (url: string | URL, options?: RequestInit) => {
      const parsedBody = JSON.parse(String(options?.body)) as Record<string, unknown>;
      calls.push({
        url: String(url),
        headers: options?.headers as Record<string, string>,
        body: parsedBody,
      });
      const query = String(parsedBody.query ?? "");
      if (query.includes("commentCreate")) {
        return responseByOperation.commentCreate ?? new Response(JSON.stringify({
          data: {
            commentCreate: { success: true, comment: { id: "comment_01", url: "https://linear.app/comment/1" } },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (query.includes("issueUpdate")) {
        return responseByOperation.issueUpdate ?? new Response(JSON.stringify({
          data: {
            issueUpdate: { success: true, issue: { id: "lin_issue_03", state: { id: "state_done", name: "Done", type: "completed" } } },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return responseByOperation.issue ?? new Response(JSON.stringify({
        data: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  };

  it("ingests a Linear issue into the task store", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });

    const result = await adapter.ingest({
      id: "lin_issue_01",
      identifier: "ENG-123",
      url: "https://linear.app/agentrail/issue/ENG-123/integrate-linear",
      title: "Integrate Linear issue source",
      description: "Build the Linear adapter.\n\n## Acceptance Criteria\n- [ ] Linear issues create AgentRail tasks.",
      priorityLabel: "High",
      state: { id: "state_started", name: "In Progress", type: "started" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      assignee: { id: "user_01", name: "Avery Engineer" },
      labels: { nodes: [{ name: "integration" }, { name: "P1" }] },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    }, "linear-delivery-01");

    assert.ok(result.taskId.startsWith("tsk_"));
    assert.equal(result.outcome, "created");
    assert.equal(result.identifier, "linear:agentrail:issues/ENG-123");
    assert.equal(result.status, "in_progress");
    assert.deepEqual(result.availableActions, ["submit"]);

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.equal(stored.title, "Integrate Linear issue source");
    assert.equal(stored.status, "in_progress");
    assert.equal(stored.priority, "high");
    assert.deepEqual(stored.assignee, { id: "user_01", name: "Avery Engineer" });
    assert.equal(stored.assigneeAgentId, null);
    assert.equal(stored.links.issue, "https://linear.app/agentrail/issue/ENG-123/integrate-linear");
    assert.deepEqual(stored.acceptanceCriteria, ["Linear issues create AgentRail tasks."]);
    assert.equal(stored.context.project, "ENG");
    assert.equal(stored.source?.provider, "linear");
    assert.equal(stored.source?.linearIssueId, "lin_issue_01");
    assert.equal(stored.source?.linearIdentifier, "ENG-123");
    assert.equal(stored.source?.linearTeamKey, "ENG");
    assert.equal(stored.source?.workflowStateType, "started");
    assert.deepEqual(stored.source?.labels, ["integration", "P1"]);
    assert.equal(stored.source?.deliveryId, "linear-delivery-01");
  });

  it("rejects required routing when no active routing rule set exists", async () => {
    const queue = makeQueue();
    const routing = new RoutingControlPlane({ now, taskQueue: queue });
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: queue,
      routingControlPlane: routing,
      routingMode: "required",
      now,
    });

    await assert.rejects(
      adapter.ingest(makeLinearIssuePayload(), "linear-required-no-rules"),
      (err: unknown) => typeof err === "object"
        && err !== null
        && "statusCode" in err
        && err.statusCode === 404
        && "code" in err
        && err.code === "not_found",
    );
    assert.equal(queue.listRawTasks().length, 0);
  });

  it("routes imported Linear issues to fallback triage when no deterministic rule matches", async () => {
    const queue = makeQueue();
    const routing = new RoutingControlPlane({ now, taskQueue: queue });
    seedRoutingRuleSet(routing, [
      {
        id: "rule_unrelated_repo",
        name: "Unrelated repository",
        enabled: true,
        priority: 10,
        conditions: {
          repositories: ["other/workspace"],
        },
        target: { type: "triage_queue", id: "triage_other" },
        confidence: 0.5,
        explanation: "This rule intentionally does not match the Linear issue.",
      },
    ]);
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: queue,
      routingControlPlane: routing,
      routingMode: "required",
      now,
    });

    const first = await adapter.ingest(makeLinearIssuePayload(), "linear-required-triage");
    const replay = await adapter.ingest(makeLinearIssuePayload(), "linear-required-triage");

    assert.equal(first.taskId, replay.taskId);
    assert.deepEqual(first.routing, { kind: "triage", target: "triage_engineering" });
    const stored = queue.getRawTask(first.taskId);
    assert.ok(stored);
    assert.equal(stored.triageQueueId, "triage_engineering");
    assert.equal(stored.assignmentSource, "manual_triage");
    assert.ok(stored.routingDecisionId);
    assert.ok(routing.getRoutingAudit(stored.routingDecisionId));
  });

  it("routes imported Linear issues to matching agents with routing audit metadata", async () => {
    const queue = makeQueue();
    const routing = new RoutingControlPlane({ now, taskQueue: queue });
    seedRoutingProfile(routing);
    seedRoutingRuleSet(routing, [
      {
        id: "rule_linear_integration",
        name: "Linear integration issues",
        enabled: true,
        priority: 10,
        conditions: {
          repositories: ["agentrail/ENG"],
          labelsAny: ["integration"],
        },
        target: { type: "agent", id: "agt_linear" },
        confidence: 0.96,
        explanation: "Linear integration work routes to the Linear agent.",
      },
    ]);
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: queue,
      routingControlPlane: routing,
      routingMode: "required",
      now,
    });

    const result = await adapter.ingest(makeLinearIssuePayload(), "linear-required-assigned");

    assert.deepEqual(result.routing, { kind: "assigned", target: "Linear Agent" });
    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.equal(stored.assigneeAgentId, "agt_linear");
    assert.equal(stored.assignmentSource, "deterministic_rule");
    assert.ok(stored.routingDecisionId);
    assert.ok(routing.getRoutingAudit(stored.routingDecisionId));
  });

  it("classifies identical repeat Linear intake as unchanged", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });
    const payload = {
      id: "lin_issue_unchanged",
      identifier: "ENG-777",
      url: "https://linear.app/agentrail/issue/ENG-777/no-op-repeat",
      title: "No-op repeat",
      description: "Keep everything the same.",
      state: { id: "state_backlog", name: "Backlog", type: "backlog" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      assignee: { id: "user_01", name: "Avery Engineer" },
      labels: { nodes: [{ name: "integration" }] },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    };

    const first = await adapter.ingest(payload, "linear-unchanged-01");
    const second = await adapter.ingest(payload, "linear-unchanged-02");

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "unchanged");
    assert.equal(second.taskId, first.taskId);
    const stored = queue.getRawTask(second.taskId);
    assert.ok(stored);
    assert.equal(stored.title, "No-op repeat");
    assert.equal(stored.description, "Keep everything the same.");
    assert.equal(stored.status, "todo");
    assert.equal(stored.context.project, "ENG");
    assert.deepEqual(stored.source?.labels, ["integration"]);
    assert.deepEqual(stored.assignee, { id: "user_01", name: "Avery Engineer" });
    assert.equal(stored.assigneeAgentId, null);
    assert.equal(stored.source?.deliveryId, "linear-unchanged-01");
  });

  it("updates the existing task when a signed Linear Issue webhook arrives", async () => {
    const queue = makeQueue();
    const secret = "linear-webhook-secret";
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: secret, now });
    const createdAt = now().toISOString();
    const payload = {
      action: "update",
      type: "Issue",
      createdAt,
      webhookTimestamp: now().getTime(),
      data: {
        id: "lin_issue_02",
        identifier: "ENG-124",
        url: "https://linear.app/agentrail/issue/ENG-124/state-sync",
        title: "State sync",
        description: "Keep status aligned.",
        priorityLabel: "Urgent",
        state: { id: "state_done", name: "Done", type: "completed" },
        team: { id: "team_01", key: "ENG", name: "Engineering" },
        assignee: { id: "user_02", name: "Dana Reviewer" },
        labels: [{ name: "release" }],
        workspace: { id: "workspace_01", urlKey: "agentrail" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const result = await adapter.receiveWebhook({
      rawBody,
      headers: {
        "linear-delivery": "delivery-124",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
    });

    assert.equal(result.data.matchedTasks.length, 1);
    assert.equal(result.data.ignored, false);
    assert.equal(result.data.deliveryId, "delivery-124");
    assert.equal(result.data.eventType, "Issue");
    const upsertedTaskId = result.data.matchedTasks[0];
    assert.ok(typeof upsertedTaskId === "string" && upsertedTaskId.startsWith("tsk_"));
    const stored = queue.getRawTask(upsertedTaskId);
    assert.ok(stored);
    assert.equal(stored.identifier, "linear:agentrail:issues/ENG-124");
    assert.equal(stored.status, "done");
    assert.equal(stored.priority, "critical");
    assert.equal(stored.source?.deliveryId, "delivery-124");
    assert.deepEqual(stored.source?.labels, ["release"]);
    assert.deepEqual(stored.assignee, { id: "user_02", name: "Dana Reviewer" });
  });

  it("marks repeated Linear Issue webhook deliveries as deduplicated", async () => {
    const queue = makeQueue();
    const secret = "linear-webhook-secret";
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: secret, now });
    const payload = {
      action: "update",
      type: "Issue",
      createdAt: now().toISOString(),
      webhookTimestamp: now().getTime(),
      data: {
        id: "lin_issue_dedupe",
        identifier: "ENG-224",
        title: "Deduplicate webhook",
        description: "Same delivery should replay.",
        state: { id: "state_backlog", name: "Backlog", type: "backlog" },
        team: { id: "team_01", key: "ENG", name: "Engineering" },
        workspace: { id: "workspace_01", urlKey: "agentrail" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const request = {
      rawBody,
      headers: {
        "linear-delivery": "delivery-dedupe",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
    };

    const first = await adapter.receiveWebhook(request);
    const replay = await adapter.receiveWebhook(request);

    assert.equal(first.data.deduplicated, false);
    assert.equal(replay.data.deduplicated, true);
    assert.deepEqual(replay.data.matchedTasks, first.data.matchedTasks);
  });

  it("rejects Linear webhooks with an invalid signature", async () => {
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      webhookSecret: "linear-webhook-secret",
      now,
    });

    await assert.rejects(
      adapter.receiveWebhook({
        rawBody: JSON.stringify({ type: "Issue", webhookTimestamp: now().getTime(), data: {} }),
        headers: { "linear-signature": "bad" },
      }),
      (err: unknown) => {
        return typeof err === "object"
          && err !== null
          && "statusCode" in err
          && err.statusCode === 401
          && "code" in err
          && err.code === "linear_webhook_unauthorized";
      },
    );
  });

  it("rejects Linear issue webhooks when no webhook secret is configured", async () => {
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      now,
    });

    await assert.rejects(
      adapter.receiveWebhook({
        rawBody: JSON.stringify({ type: "Issue", webhookTimestamp: now().getTime(), data: {} }),
        headers: {},
      }),
      (err: unknown) => {
        return typeof err === "object"
          && err !== null
          && "statusCode" in err
          && err.statusCode === 503
          && "code" in err
          && err.code === "misconfigured";
      },
    );
  });

  it("matches existing Linear tasks by immutable issue id and refreshes the identifier", async () => {
    const queue = makeQueue();
    const secret = "linear-webhook-secret";
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: secret, now });
    const existing = queue.createTask({
      identifier: "linear:agentrail:issues/ENG-124",
      title: "Old identifier",
      description: "Old description",
      status: "todo",
      priority: "medium",
      assignee: { id: "user_legacy", name: "Legacy Engineer" },
      assigneeAgentId: "user_legacy",
      links: { issue: "https://linear.app/agentrail/issue/ENG-124/old-identifier" },
      context: { project: "ENG", goal: "Legacy Linear task" },
      availableActions: ["start"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_legacy",
        linearIdentifier: "ENG-124",
      },
    });
    const payload = {
      action: "update",
      type: "Issue",
      createdAt: now().toISOString(),
      webhookTimestamp: now().getTime(),
      data: {
        id: "lin_issue_legacy",
        identifier: "PLAT-9",
        url: "https://linear.app/platform/issue/PLAT-9/moved-task",
        title: "Moved task",
        description: "Updated description.",
        state: { id: "state_started", name: "In Progress", type: "started" },
        team: { id: "team_02", key: "PLAT", name: "Platform" },
        assignee: { id: "user_02", name: "Dana Reviewer" },
        workspace: { id: "workspace_02", urlKey: "platform" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const result = await adapter.receiveWebhook({
      rawBody,
      headers: {
        "linear-delivery": "delivery-legacy",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
    });

    assert.deepEqual(result.data.matchedTasks, [existing.id]);
    const stored = queue.getRawTask(existing.id);
    assert.ok(stored);
    assert.equal(stored.identifier, "linear:platform:issues/PLAT-9");
    assert.equal(stored.links.issue, "https://linear.app/platform/issue/PLAT-9/moved-task");
    assert.equal(stored.source?.linearIssueId, "lin_issue_legacy");
    assert.equal(stored.source?.linearIdentifier, "PLAT-9");
    assert.equal(stored.assigneeAgentId, null);
    assert.deepEqual(stored.assignee, { id: "user_02", name: "Dana Reviewer" });
  });

  it("preserves the routed AgentRail assignee during Linear sync", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });
    const existing = queue.createTask({
      identifier: "linear:agentrail:issues/ENG-126",
      title: "Assigned task",
      description: "Existing routed task",
      status: "todo",
      priority: "medium",
      assignee: { id: "agt_claudia", name: "Claudia" },
      assigneeAgentId: "agt_claudia",
      assignmentSource: "deterministic_rule",
      links: { issue: "https://linear.app/agentrail/issue/ENG-126/assigned-task" },
      context: { project: "ENG", goal: "Existing routed task" },
      availableActions: ["start"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_126",
        linearIdentifier: "ENG-126",
      },
    });

    await adapter.ingest({
      id: "lin_issue_126",
      identifier: "ENG-126",
      url: "https://linear.app/agentrail/issue/ENG-126/assigned-task",
      title: "Assigned task",
      description: "Existing routed task",
      state: { id: "state_started", name: "In Progress", type: "started" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      assignee: { id: "lin_user_01", name: "Linear User" },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    }, "linear-assignee-preserve");

    const stored = queue.getRawTask(existing.id);
    assert.ok(stored);
    assert.deepEqual(stored.assignee, { id: "agt_claudia", name: "Claudia" });
    assert.equal(stored.assigneeAgentId, "agt_claudia");
  });

  it("keeps available actions aligned with synced Linear state for routed tasks", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });
    const existing = queue.createTask({
      identifier: "linear:agentrail:issues/ENG-127",
      title: "Routed task",
      description: "Existing routed task",
      status: "todo",
      priority: "medium",
      assignee: { id: "agt_claudia", name: "Claudia" },
      assigneeAgentId: "agt_claudia",
      assignmentSource: "deterministic_rule",
      links: { issue: "https://linear.app/agentrail/issue/ENG-127/routed-task" },
      context: { project: "ENG", goal: "Existing routed task" },
      availableActions: ["start"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_127",
        linearIdentifier: "ENG-127",
      },
    });

    await adapter.ingest({
      id: "lin_issue_127",
      identifier: "ENG-127",
      url: "https://linear.app/agentrail/issue/ENG-127/routed-task",
      title: "Routed task",
      description: "Existing routed task",
      state: { id: "state_done", name: "Done", type: "completed" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    }, "linear-actions-sync");

    const stored = queue.getRawTask(existing.id);
    assert.ok(stored);
    assert.deepEqual(stored.availableActions, []);
    assert.equal(stored.status, "done");
  });

  it("preserves the routed AgentRail assignee during signed Linear webhook updates", async () => {
    const queue = makeQueue();
    const secret = "linear-webhook-secret";
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: secret, now });
    const existing = queue.createTask({
      identifier: "linear:agentrail:issues/ENG-227",
      title: "Routed webhook task",
      description: "Existing routed task",
      status: "todo",
      priority: "medium",
      assignee: { id: "agt_claudia", name: "Claudia" },
      assigneeAgentId: "agt_claudia",
      assignmentSource: "deterministic_rule",
      links: { issue: "https://linear.app/agentrail/issue/ENG-227/routed-task" },
      context: { project: "ENG", goal: "Existing routed task" },
      availableActions: ["start"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_227",
        linearIdentifier: "ENG-227",
      },
    });
    const payload = {
      action: "update",
      type: "Issue",
      createdAt: now().toISOString(),
      webhookTimestamp: now().getTime(),
      data: {
        id: "lin_issue_227",
        identifier: "ENG-227",
        url: "https://linear.app/agentrail/issue/ENG-227/routed-task",
        title: "Routed webhook task",
        description: "Existing routed task",
        state: { id: "state_started", name: "In Progress", type: "started" },
        team: { id: "team_01", key: "ENG", name: "Engineering" },
        assignee: { id: "lin_user_02", name: "Dana Reviewer" },
        workspace: { id: "workspace_01", urlKey: "agentrail" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const result = await adapter.receiveWebhook({
      rawBody,
      headers: {
        "linear-delivery": "delivery-routed-webhook",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
    });

    assert.deepEqual(result.data.matchedTasks, [existing.id]);
    const stored = queue.getRawTask(existing.id);
    assert.ok(stored);
    assert.equal(stored.assigneeAgentId, "agt_claudia");
    assert.deepEqual(stored.assignee, { id: "agt_claudia", name: "Claudia" });
  });

  it("ignores unsupported Linear Issue webhook actions", async () => {
    const queue = makeQueue();
    const secret = "linear-webhook-secret";
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, webhookSecret: secret, now });
    const payload = {
      action: "remove",
      type: "Issue",
      createdAt: now().toISOString(),
      webhookTimestamp: now().getTime(),
      data: {
        id: "lin_issue_deleted",
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const result = await adapter.receiveWebhook({
      rawBody,
      headers: {
        "linear-delivery": "delivery-remove",
        "linear-event": "Issue",
        "linear-signature": signature,
      },
    });

    assert.deepEqual(result.data, {
      matchedTasks: [],
      deduplicated: false,
      ignored: true,
      deliveryId: "delivery-remove",
      eventType: "Issue",
    });
  });

  it("uses personal API key authorization for Linear GraphQL mutations", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      linearApiKey: "lin_api_key_test",
      fetch: createMockLinearFetch(calls),
    });

    const comment = await adapter.createComment("lin_issue_03", "Submitted PR https://github.com/agentrail/agentrail/pull/123");
    const update = await adapter.updateIssueState("lin_issue_03", "state_done");

    assert.equal(comment.data.commentId, "comment_01");
    assert.equal(update.data.issueId, "lin_issue_03");
    assert.equal(update.data.agentRailStatus, "done");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://api.linear.app/graphql");
    assert.equal(calls[0]!.headers.authorization, "lin_api_key_test");
    assert.match(String(calls[0]!.body.query), /commentCreate/);
    assert.deepEqual(calls[0]!.body.variables, {
      input: {
        issueId: "lin_issue_03",
        body: "Submitted PR https://github.com/agentrail/agentrail/pull/123",
      },
    });
    assert.match(String(calls[1]!.body.query), /issueUpdate/);
    assert.deepEqual(calls[1]!.body.variables, {
      id: "lin_issue_03",
      input: { stateId: "state_done" },
    });
  });

  it("surfaces Linear GraphQL errors for outbound mutations", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      linearApiKey: "lin_api_key_test",
      fetch: createMockLinearFetch(calls, {
        commentCreate: new Response(JSON.stringify({
          data: null,
          errors: [{ message: "Denied" }],
        }), { status: 200, headers: { "content-type": "application/json" } }),
      }),
    });

    await assert.rejects(
      adapter.createComment("lin_issue_03", "Comment body"),
      /Linear GraphQL error: 200/,
    );
  });

  it("propagates network failures from Linear outbound mutations", async () => {
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      linearApiKey: "lin_api_key_test",
      fetch: async () => {
        throw new Error("network exploded");
      },
    });

    await assert.rejects(
      adapter.updateIssueState("lin_issue_03", "state_done"),
      /network exploded/,
    );
  });

  it("handles malformed GraphQL responses without crashing outbound mutations", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: makeQueue(),
      linearApiKey: "lin_api_key_test",
      fetch: createMockLinearFetch(calls, {
        issueUpdate: new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      }),
    });

    const result = await adapter.updateIssueState("lin_issue_03", "state_done");
    assert.equal(result.data.success, false);
    assert.equal(result.data.issueId, null);
    assert.equal(result.data.stateName, null);
  });

  it("imports a Linear issue by identifier via GraphQL", async () => {
    const queue = makeQueue();
    let requestedId = "";
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: queue,
      linearApiKey: "lin_api_key_test",
      fetch: async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        requestedId = body.variables.id;
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "lin_issue_125",
              identifier: "ENG-125",
              url: "https://linear.app/agentrail/issue/ENG-125/import-via-selector",
              title: "Import via selector",
              description: "Pulled directly from Linear.",
              state: { id: "state_backlog", name: "Backlog", type: "backlog" },
              team: { id: "team_01", key: "ENG", name: "Engineering" },
              assignee: { id: "user_03", name: "Taylor Importer" },
              labels: { nodes: [{ name: "import" }] },
              organization: { id: "workspace_01", urlKey: "agentrail" },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      now,
    });

    const result = await adapter.importIssue("ENG-125", "linear-import-125");

    assert.equal(requestedId, "ENG-125");
    assert.equal(result.linearIssueId, "lin_issue_125");
    assert.equal(result.identifier, "linear:agentrail:issues/ENG-125");
    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.equal(stored.source?.linearIssueId, "lin_issue_125");
    assert.equal(stored.source?.linearIdentifier, "ENG-125");
    assert.equal(stored.source?.linearWorkspaceUrlKey, "agentrail");
    assert.equal(stored.source?.workflowStateType, "backlog");
    assert.equal(stored.status, "todo");
  });

  it("refreshes an imported Linear task by immutable issue id", async () => {
    const queue = makeQueue();
    const existing = queue.createTask({
      identifier: "linear:agentrail:issues/ENG-126",
      title: "Before refresh",
      description: "Old",
      status: "todo",
      priority: "medium",
      assignee: { id: "user_old", name: "Old Assignee" },
      assigneeAgentId: null,
      links: { issue: "https://linear.app/agentrail/issue/ENG-126/old" },
      context: { project: "ENG", goal: "Old linear task" },
      availableActions: ["start"],
      source: {
        provider: "linear",
        linearIssueId: "lin_issue_refresh",
        linearIdentifier: "ENG-126",
      },
    });
    const adapter = new LinearIssueSourceAdapter({
      taskQueue: queue,
      linearApiKey: "lin_api_key_test",
      fetch: async () => new Response(JSON.stringify({
        data: {
          issue: {
            id: "lin_issue_refresh",
            identifier: "ENG-126",
            url: "https://linear.app/agentrail/issue/ENG-126/refreshed",
            title: "After refresh",
            description: "Fresh copy",
            state: { id: "state_started", name: "In Progress", type: "started" },
            team: { id: "team_01", key: "ENG", name: "Engineering" },
            assignee: { id: "user_new", name: "New Assignee" },
            labels: { nodes: [{ name: "refresh" }] },
            organization: { id: "workspace_01", urlKey: "agentrail" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      now,
    });

    const result = await adapter.refreshIssue("lin_issue_refresh");

    assert.equal(result.taskId, existing.id);
    const stored = queue.getRawTask(existing.id);
    assert.ok(stored);
    assert.equal(stored.title, "After refresh");
    assert.equal(stored.status, "in_progress");
    assert.deepEqual(stored.assignee, { id: "user_new", name: "New Assignee" });
    assert.deepEqual(stored.source?.labels, ["refresh"]);
    assert.equal(stored.source?.linearTeamKey, "ENG");
  });

  it("maps P2 labels to medium priority", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });

    const result = await adapter.ingest({
      id: "lin_issue_p2",
      identifier: "ENG-902",
      url: "https://linear.app/agentrail/issue/ENG-902/p2-priority",
      title: "Treat P2 as medium priority",
      description: "Keep the priority mapping aligned with standard conventions.",
      priority: 0,
      priorityLabel: null,
      state: { id: "state_backlog", name: "Backlog", type: "backlog" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      assignee: { id: "user_01", name: "Avery Engineer" },
      labels: { nodes: [{ name: "P2" }] },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    }, "linear-p2-priority");

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.equal(stored.priority, "medium");
  });

  it("builds Linear fallback issue URLs with the workspace key", async () => {
    const queue = makeQueue();
    const adapter = new LinearIssueSourceAdapter({ taskQueue: queue, now });

    const result = await adapter.ingest({
      id: "lin_issue_fallback_url",
      identifier: "ENG-903",
      title: "Missing URL",
      description: "Linear payload omitted url.",
      state: { id: "state_backlog", name: "Backlog", type: "backlog" },
      team: { id: "team_01", key: "ENG", name: "Engineering" },
      workspace: { id: "workspace_01", urlKey: "agentrail" },
    }, "linear-fallback-url");

    const stored = queue.getRawTask(result.taskId);
    assert.ok(stored);
    assert.equal(stored.links.issue, "https://linear.app/agentrail/issue/ENG-903");
  });
});

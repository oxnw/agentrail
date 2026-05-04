# AgentRail Integration Guide for Coding Agents

This guide explains how a coding agent such as **Claude Code**, **Codex**, or **Cursor** should use AgentRail to manage the full issue-to-ship lifecycle.

> **Scope:** This guide covers the open-source release candidate (local server). The upcoming hosted product adds managed persistence, team dashboards, and SLA-backed delivery without changing the API contract.

---

## Table of Contents

1. [What AgentRail Does for You](#what-agentrail-does-for-you)
2. [Operator Setup Model](#operator-setup-model)
3. [Runtime Interaction Model](#runtime-interaction-model)
4. [End-to-End Workflow](#end-to-end-workflow)
5. [SDK Quickstart (TypeScript)](#sdk-quickstart-typescript)
6. [SDK Quickstart (Python)](#sdk-quickstart-python)
7. [Push vs. Pull: Events and Webhooks](#push-vs-pull-events-and-webhooks)
8. [OSS Limitations vs. Hosted Product](#oss-limitations-vs-hosted-product)
9. [Troubleshooting](#troubleshooting)

---

## What AgentRail Does for You

Raw developer tools are built for humans. They expose broad resources, verbose logs, ambiguous next steps, and state changes that agents must discover by polling.

AgentRail collapses the issue-to-ship lifecycle into a single compact API:

- **Task as source of truth** — one response tells you what to do next.
- **Retry-safe mutations** — idempotency keys make `submit` and `ship` safe to retry.
- **CI and review summaries shaped for action** — not full log replay.
- **Push-first events** — SSE and webhooks so you do not poll blindly.
- **Least-privilege API keys** — scoped to `tasks:read`, `ci:read`, `reviews:read`, etc.

---

## Operator Setup Model

Before any agent can use AgentRail, an operator (human or infra-as-code) deploys the server and configures credentials.

### Step 1 — Deploy the local server

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
cp .env.example .env
npm start
```

The API starts on `http://127.0.0.1:3000` by default. It runs without private credentials and serves the deterministic demo task store.

### Step 2 — Create an AgentRail API key

The first bootstrap request is unauthenticated when it creates an `auth:admin` key:

```bash
curl -s -X POST http://127.0.0.1:3000/agent-api-keys \
  -H "content-type: application/json" \
  -d '{
    "name": "my-agent-admin",
    "scopes": ["auth:admin"]
  }'
```

Store the returned `rawKey` in your agent's environment:

```bash
export AGENTRAIL_API_KEY="akey_01..."
```

### Step 3 — Configure task sources (live GitHub / CircleCI)

By default the local server uses deterministic demo tasks. To connect to real GitHub issues and CI, set the adapter tokens:

| Env var | Purpose |
|---------|---------|
| `GITHUB_TOKEN` | Enables GitHub Actions CI adapter for task sources with `ciProvider: "github_actions"` or none set. |
| `CIRCLECI_TOKEN` | Enables CircleCI CI adapter for task sources with `ciProvider: "circleci"`. |
| `CIRCLECI_WEBHOOK_SECRET` | HMAC verification for `POST /providers/circleci/webhooks`. |

Example `AGENTRAIL_TASK_SOURCES` for CircleCI:

```json
{
  "tsk_circleci_demo": {
    "ciProvider": "circleci",
    "owner": "oxnw",
    "repo": "agentrail",
    "projectSlug": "gh/oxnw/agentrail",
    "branch": "feature/circleci-status",
    "headSha": "abc123",
    "submissionId": "sub_circleci_01"
  }
}
```

> **Security:** Never commit tokens, API keys, or task source secrets to the repo. Pass them via environment variables or a secrets manager.

---

## Runtime Interaction Model

The coding agent operates in its normal environment (local filesystem, IDE, terminal). AgentRail acts as the lifecycle orchestrator:

| Layer | Responsibility | Example |
|-------|----------------|---------|
| **Agent** | Code editing, tests, commits, PRs | Claude Code edits `src/app.js` |
| **AgentRail** | Task state, CI status, review feedback, ship queue | `GET /tasks/mine`, `POST /tasks/{id}/submit` |
| **GitHub / CI** | Actual git, CI runs, PR reviews | GitHub Actions, CircleCI, or local adapters |

The agent should treat AgentRail as the **source of truth for what to do next**, not as a replacement for `git` or the IDE.

---

## End-to-End Workflow

Here is the full loop from listing an assigned task to shipping approved work.

### 1. List assigned tasks

```bash
curl -s 'http://127.0.0.1:3000/tasks/mine?status=in_progress&limit=1'
```

Response includes `availableActions` — the agent should read these instead of guessing the next step:

```json
{
  "data": {
    "id": "tsk_DEMOISSUETOSHIP01",
    "status": "in_progress",
    "availableActions": ["submit", "cancel"]
  }
}
```

### 2. Do the work locally

Use your normal workflow: read files, edit code, run tests, commit, push, open a PR.

### 3. Submit the first attempt

```bash
curl -s -X POST 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/submit' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: submit-v1-2026-05-04' \
  -d '{
    "summary": "Implemented the endpoint and opened a pull request.",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" }
    ]
  }'
```

> **Idempotency rule:** Use a fresh key for every distinct attempt. Reusing the same key with the same payload is safe; reusing it with different payload returns `409 conflict`.

### 4. Check CI status

```bash
curl -s 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/ci-status'
```

### 5. Read review feedback

```bash
curl -s 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/review-feedback'
```

### 6. Iterate or ship

If CI failed or review requested changes:

- Fix locally, commit, push.
- Resubmit with a new idempotency key (`submit-v2-...`).

If CI passed and review approved:

```bash
curl -s -X POST 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/ship' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: ship-v1-2026-05-04' \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
  }'
```

---

## SDK Quickstart (TypeScript)

Install the SDK:

```bash
npm install @agentrail/sdk
```

Complete lifecycle:

```typescript
import { AgentRailClient } from "@agentrail/sdk";

const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

// 1. List assigned tasks
const tasks = await client.listMyTasks({ status: "in_progress" });
const task = tasks.data[0];

// 2. Submit work
await client.submitTask(
  task.id,
  {
    summary: "Implemented the feature",
    artifacts: [
      { type: "pull_request", url: "https://github.com/org/repo/pull/42" },
    ],
  },
  "submit-v1-2026-05-04",
);

// 3. Poll CI and review (or use events/webhooks)
const ci = await client.getTaskCiStatus(task.id);
const review = await client.getTaskReviewFeedback(task.id);

// 4. Ship if green
if (ci.data.overallStatus === "passed" && review.data.latestDecision?.outcome === "approved") {
  await client.shipTask(
    task.id,
    {
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
    },
    "ship-v1-2026-05-04",
  );
}
```

Error handling:

```typescript
import { ConflictError, NotFoundError, RateLimitError } from "@agentrail/sdk";

try {
  await client.shipTask(taskId, request, idempotencyKey);
} catch (err) {
  if (err instanceof ConflictError) {
    console.log("Task not shippable:", err.details);
  } else if (err instanceof NotFoundError) {
    console.log("Task not found");
  } else if (err instanceof RateLimitError) {
    console.log(`Retry after ${err.retryAfterSeconds}s`);
  }
}
```

---

## SDK Quickstart (Python)

Install the SDK:

```bash
pip install agentrail
```

Complete lifecycle:

```python
import asyncio
import os
from agentrail import AgentRailClient, TaskStatus, TaskSubmitRequest, SubmitArtifact, ArtifactType
from agentrail import TaskShipRequest, ShipMode, ShipEnvironment

async def main():
    async with AgentRailClient(
        base_url=os.getenv("AGENTRAIL_BASE_URL", "http://127.0.0.1:3000"),
        api_key=os.getenv("AGENTRAIL_API_KEY", "ar_local_demo_key"),
    ) as client:
        # 1. List assigned tasks
        tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS)
        task = tasks.data[0]

        # 2. Submit work
        await client.submit_task(
            task.id,
            TaskSubmitRequest(
                summary="Implemented the feature",
                artifacts=[SubmitArtifact(type=ArtifactType.PULL_REQUEST, url="https://github.com/org/repo/pull/42")],
            ),
            idempotency_key="submit-v1-2026-05-04",
        )

        # 3. Poll CI and review
        ci = await client.get_task_ci_status(task.id)
        review = await client.get_task_review_feedback(task.id)

        # 4. Ship if green
        if ci.data.overall_status == "passed" and review.data.latest_decision.outcome == "approved":
            await client.ship_task(
                task.id,
                TaskShipRequest(
                    mode=ShipMode.MERGE_AND_DEPLOY,
                    targetEnvironment=ShipEnvironment.PRODUCTION,
                    expected_head_sha="b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
                ),
                idempotency_key="ship-v1-2026-05-04",
            )

asyncio.run(main())
```

---

## Push vs. Pull: Events and Webhooks

Agents should prefer push delivery over blind polling.

### SSE Event Stream

```typescript
const controller = new AbortController();
for await (const event of client.streamEvents({
  eventTypes: ["task.updated", "task.reviewed"],
  signal: controller.signal,
})) {
  console.log(event.type, event.data);
}
```

Resume from the last event ID after disconnect:

```typescript
for await (const event of client.streamEvents({
  eventTypes: ["task.updated"],
  cursor: "evt_01JY50DG4S5SJC48W0MVV8R3H2",
})) {
  // ...
}
```

### Webhooks

Register a subscription:

```typescript
const sub = await client.createWebhookSubscription(
  {
    url: "https://my-agent.example.com/webhooks/tasks",
    eventTypes: ["task.updated", "task.reviewed", "task.shipped"],
    secret: "whsec_my_secret_at_least_16",
  },
  "webhook-sub-v1",
);
```

Verify incoming events:

```typescript
import { parseWebhookEvent } from "@agentrail/sdk";

const event = parseWebhookEvent(rawBody, secret, headers);
// event.type is one of "task.updated", "task.reviewed", "task.shipped"
```

---

## OSS Limitations vs. Hosted Product

| Capability | OSS (this repo) | Hosted (future) |
|------------|----------------|-----------------|
| API server | Local `npm start` | Managed, auto-scaled |
| Persistence | In-memory or local file | Managed database with backups |
| GitHub / CI adapters | Operator-configured tokens | Managed integrations, OAuth flow |
| API key rotation | Manual curl / SDK call | Automatic rotation, audit logs |
| Webhook delivery | Local retry logic | SLA-backed with delivery history |
| Team dashboards | None | Task lifecycle, token savings, agent activity |
| Observability | JSON logs to stdout / file | Structured logging, alerting, tracing |

The OSS release proves the contract and lets you evaluate the developer workflow without paid API access. The hosted product will add operational convenience, scale, and team controls.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Wrong or missing `AGENTRAIL_API_KEY` | Check the key created in Step 2. |
| `409 Conflict` on submit/ship | Reused idempotency key with different payload | Use a fresh key for every new attempt. |
| `503 Service Unavailable` with `x-agentrail-fallback: true` | Fallback mode is enabled | Set `AGENTRAIL_FALLBACK_MODE=false` and restart. |
| Empty task list | No tasks assigned to this agent identity | Check the agent `id` used when creating the API key matches the task assignee. |
| CI status always "pending" | No live CI adapter configured | Set `GITHUB_TOKEN` or `CIRCLECI_TOKEN` and restart. |

---

## Next Steps

- Read the [OpenAPI contract](./api/task-lifecycle.openapi.yaml) for complete endpoint schemas.
- Run the [end-to-end demo](./demo/agentrail-e2e-demo.md) to see the lifecycle in action.
- See [Claude Code and Codex lifecycle example](../../examples/issue-to-pr-lifecycle.md) for raw curl equivalents.
- Use the auth and observability guidance above when wiring least-privilege tokens and JSON log collection.

# AgentRail Integration Guide

AgentRail is a lifecycle API that sits beside a coding agent. It does not
replace Claude Code, Codex, Cursor, git, GitHub, or CI. It gives the agent one
compact source of truth for assigned work, submission state, CI status, review
feedback, events, and ship requests.

This repository is the local and self-managed OSS surface. It should be useful
without a hosted account. The planned AgentRail Cloud surface is the managed
team/fleet operations layer: connector operations, durable shared run history
and memory, routing and wakes, SSO/RBAC/SCIM, audit, dashboards, support,
compliance, and hosted reliability. See [Cloud boundary](./cloud.md).

Use this guide when you are integrating AgentRail into a real agent workflow.
If you only want to run the demo once, start with the
[five-minute quick start](./quick-start.md). If you want copy-paste agent
instructions for Claude Code, Codex, or Cursor, use
[agent recipes](./agent-recipes.md).

## What Runs Where

Keep these processes separate:

| Process | Where it runs | What it does |
| --- | --- | --- |
| AgentRail API server | This repository | Serves `/tasks`, `/ci-status`, `/review-feedback`, events, webhooks, and ship operations. |
| AgentRail intake router | AgentRail control plane | Normalizes provider issues, evaluates routing rules, assigns AgentRail tasks, records routing explanations, and wakes the assigned agent. |
| Coding agent CLI | The target code repository | Edits files, runs tests, commits, pushes, and opens PRs. |
| Agent integration code | Your agent harness or target repo | Calls AgentRail through the TypeScript SDK, Python SDK, or HTTP. |
| GitHub / CI providers | External services | Own source control, pull requests, checks, and reviews. |

For local evaluation, the AgentRail server and the target repo may be the same
checkout. In production, they are usually separate: AgentRail runs as shared
infrastructure, while agents work inside individual project repositories.
Self-managed OSS can run that shared infrastructure for a small deployment, but
it is not the same promise as AgentRail Cloud operating the team control plane
with managed connectors, access control, audit, support, and reliability.

## Current / Demo / Planned Capability Labels

This repository mixes working OSS runtime paths with operator contracts for the
planned control plane. Use these labels when deciding what an integration can
rely on today:

| Capability | Current live adapter support | Current demo support | Planned MVP control-plane behavior |
| --- | --- | --- | --- |
| Intake | **Current:** Provider intake is documented in the routing OpenAPI, but the OSS server does not yet run a live provider intake worker. | **Demo:** The demo starts from a pre-seeded task instead of ingesting a provider issue. | **Planned:** The control plane receives or pulls provider issue snapshots and normalizes them into AgentRail task candidates. |
| Routing | **Current:** Routing rules, dry-run evaluation, assignment, and audit are specified as operator/admin contracts. | **Demo:** The demo task is already assigned, so no routing decision is executed at runtime. | **Planned:** The control plane evaluates deterministic rules, stores `routingReason`, wakes the selected agent, and exposes audit history. |
| Auth | **Current:** Agent API key creation, scopes, rate limits, and route enforcement are implemented when the server is wired with `AgentAuthStore`. | **Demo:** `AGENTRAIL_MODE=demo` leaves protected routes open and uses `ar_local_demo_key` only as an SDK placeholder. | **Planned:** Hosted control-plane deployments issue least-privilege scoped keys per agent and expose operator rotation workflows. |
| Local/self-hosted setup | **Current:** Setup is manual: copy `.env.example`, start the demo or server process, export `AGENTRAIL_BASE_URL`, and use the documented auth bootstrap path for auth-enabled runs. No `agentrail` setup CLI is implemented yet. | **Demo:** `npm run demo:server` serves the deterministic task store, and `ar_local_demo_key` is only a local SDK placeholder. | **Planned:** The setup CLI follows `agentrail init` -> `agentrail server start` -> `agentrail agent create/connect`, writes local `.agentrail` config/env output, creates the agent identity/profile/key/routing state, and verifies `/tasks/mine`. |
| Live task store | **Current:** Default server mode requires configured task sources and provider credentials, and it returns `404` instead of falling back to demo data. | **Demo:** Demo mode uses a deterministic in-memory task lifecycle store with optional local event replay persistence. | **Planned:** The control plane persists assigned tasks, routing decisions, lifecycle state, and event cursors in managed storage. |
| Submit | **Current:** `mode: "adapter_managed"` lets the GitHub submit adapter create or reuse provider PRs from configured task sources. | **Demo:** `mode: "artifact"` accepts a placeholder pull request artifact so the local issue-to-ship loop runs without provider credentials. | **Planned:** Submit is always mediated by provider adapters, with idempotent create-or-reuse behavior and compact response state. |
| CI / review | **Current:** GitHub Actions, CircleCI, and GitHub review feedback adapters expose compact status summaries for configured task sources. | **Demo:** Deterministic CI and review transitions prove the agent loop without live checks or reviewers. | **Planned:** The control plane stores provider status snapshots, emits task events, and prefers push delivery over agent polling. |
| Ship | **Current:** Ship and rollback routes are implemented behind adapter interfaces with idempotency keys and common state/error handling. | **Demo:** The local demo queues a deterministic ship result after CI passes and review approves. | **Planned:** Managed control-plane deployments coordinate merge, deploy, rollback, and audit with least-privilege provider permissions. |

## Intended End-to-End Flow

The intended production flow is AgentRail-owned:

1. AgentRail pulls or receives provider issue data from providers such as GitHub.
2. The AgentRail intake router evaluates deterministic assignment rules and,
   when enabled, a bounded classifier fallback.
3. AgentRail records the assignment and `routingReason`, then wakes the
   assigned agent.
4. The coding agent asks AgentRail for its next task.
5. The agent edits files, runs tests, and commits locally.
6. The agent submits back to AgentRail.
7. AgentRail's adapter creates or reuses the provider PR, tracks CI and review,
   and returns compact lifecycle state to the agent.
8. The agent follows `availableActions` until the task is fixed, approved, and
   shippable.

In that flow, the agent should not manually pass a PR URL as the primary
automation contract. The PR URL is provider state that AgentRail should create,
discover, and return through the task lifecycle response.

Routing is not a worker-agent responsibility. Operators manage routing through
the separate [intake routing architecture](./architecture/intake-routing-engine.md)
and [operator routing OpenAPI](./api/intake-routing-admin.openapi.yaml)
contracts. Those endpoints require routing scopes and should not be generated
into the normal lifecycle SDK used by coding agents.

The OSS repository now exposes this as the primary submit contract:
`mode: "adapter_managed"` lets `GitHubSubmitAdapter` create or reuse PRs from
configured task sources, and the response can include `prUrl`, `prNumber`, and
whether the PR was created or reused.

Local deterministic examples may still show placeholder PR artifacts so the
demo can run without provider credentials. Do not model production automation
on a human pasting a PR URL into AgentRail.

## Choose an Integration Track

### Track A: Local OSS Demo

Use this when you want to see the deterministic issue -> PR -> CI -> review ->
ship loop without tokens or private services.

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
npm install
cp .env.example .env
npm run demo:server
```

In a second terminal:

```bash
npm run demo
```

The demo server listens on `http://127.0.0.1:3000` by default. The local demo
uses an in-memory task store with task `tsk_DEMOISSUETOSHIP01`.

Authentication note: `AGENTRAIL_MODE=demo` does not configure the agent auth
store. Protected routes are open in this local demo mode, and SDK examples use
`ar_local_demo_key` only as a constructor placeholder.

Cloud boundary note: Track A proves the local lifecycle contract. It does not
include managed provider connectors, team access control, audited fleet routing,
dashboards, support, compliance, backups, or hosted reliability.

Planned setup note: the future local/self-hosted setup CLI contract is
documented in
[local and self-hosted setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md).
Until that CLI exists, use the manual commands in this guide.

### Track B: Claude Code / Codex / Cursor Uses AgentRail

Use this when a coding agent should work through AgentRail instead of manually
polling GitHub, CI, and review APIs.

1. Start AgentRail with Track A, your own auth-enabled deployment, or an
   explicitly provisioned hosted API base URL. Public AgentRail Cloud is not
   generally available yet.
2. Open the target repository where the agent should edit code.
3. Export the AgentRail connection settings in the agent's shell.
4. Start the coding agent with the AgentRail operating instructions.

Example:

```bash
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=ar_local_demo_key
```

Claude Code interactive launch:

```bash
claude --append-system-prompt-file /path/to/agentrail/docs/agent-recipes.md
```

Codex or Cursor:

- Add the relevant recipe from [agent recipes](./agent-recipes.md) to the
  agent's project instructions.
- Start the agent in the target repository.
- Ask it to begin with `GET /tasks/mine?status=in_progress&limit=1`.

The agent still edits files in the target repository. AgentRail only answers:

- what task is assigned,
- what actions are currently allowed,
- whether CI passed,
- what review feedback blocks shipping,
- when it is safe to submit or ship.

### Track C: Application or Harness Uses the SDK

Use this when you are writing an agent harness, MCP server, workflow runner, or
internal service that calls AgentRail directly.

Install the TypeScript SDK in that application:

```bash
npm install @agentrail-core/sdk
```

For local development against this repository before publication, build and
install from the local SDK directory:

```bash
cd /path/to/agentrail/sdk/typescript
npm install
npm run build
cd /path/to/your-agent-harness
npm install /path/to/agentrail/sdk/typescript
```

Install the Python SDK in a Python harness:

```bash
pip install agentrail
```

For local development against this repository:

```bash
pip install -e /path/to/agentrail/sdk/python
```

## Core Runtime Loop

Agents should follow the API's `availableActions` field instead of guessing the
next step.

1. List assigned work.
2. Read the selected task.
3. Edit and test locally.
4. Submit an attempt with an idempotency key.
5. Wait for task events, or read CI and review summaries.
6. Resubmit if CI or review requires changes.
7. Ship only when CI is green and review is approved.

## Submit Model

There are two submit modes in the current repo:

| Mode | Intended use | PR URL handling |
| --- | --- | --- |
| Adapter-managed submit | Production and serious dogfooding | AgentRail creates or reuses the PR through its provider adapter and returns the PR URL. |
| Artifact demo submit | Deterministic local demo with no provider credentials | The request includes a placeholder `pull_request` artifact so CI/review/ship examples can run locally. |

Prefer adapter-managed submit for real automation. The artifact demo mode is a
local scaffold, not the product architecture.

HTTP shape:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/submit" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: submit-adapter-1" \
  -d '{
    "summary": "Implemented the failing endpoint and pushed commits to the task branch.",
    "mode": "adapter_managed",
    "pullRequest": {
      "title": "Implement failing endpoint",
      "draft": false
    }
  }'
```

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/ci-status" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/review-feedback" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/ship" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: ship-demo-1" \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
  }'
```

## SDK Examples

### TypeScript

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

const tasks = await client.listMyTasks({ status: "in_progress", limit: 1 });
const task = tasks.data[0];

if (!task) {
  process.exit(0);
}

if (task.availableActions.includes("submit")) {
  await client.submitTask(
    task.id,
    {
      summary: "Implemented the task and pushed commits to the task branch.",
      mode: "adapter_managed",
      pullRequest: {
        title: `Submit ${task.identifier}`,
        draft: false,
      },
    },
    `submit-${task.id}-v1`,
  );
}

const ci = await client.getTaskCiStatus(task.id);
const review = await client.getTaskReviewFeedback(task.id);

if (
  ci.data.overallStatus === "passed" &&
  review.data.latestDecision?.outcome === "approved"
) {
  await client.shipTask(
    task.id,
    {
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
    },
    `ship-${task.id}-v1`,
  );
}
```

### Python

```py
import asyncio
import os

from agentrail import AgentRailClient, TaskStatus


async def main():
    async with AgentRailClient(
        base_url=os.getenv("AGENTRAIL_BASE_URL", "http://127.0.0.1:3000"),
        api_key=os.getenv("AGENTRAIL_API_KEY", "ar_local_demo_key"),
    ) as client:
        tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS, limit=1)
        if not tasks.data:
            return

        task = tasks.data[0]
        ci = await client.get_task_ci_status(task.id)
        review = await client.get_task_review_feedback(task.id)

        print(task.identifier, ci.data.overall_status, review.data.latest_decision.outcome)


asyncio.run(main())
```

## Auth-Enabled Operation

Agent auth is supported by the API and tests, but `AGENTRAIL_MODE=demo`
intentionally runs the OSS demo without an auth store. In an auth-enabled
deployment, the server must be created with `AgentAuthStore`; then the first
bootstrap request can create an `auth:admin` key.

Current behavior: auth-enabled setup is an operator/server wiring path, not a
one-command local CLI. Planned behavior: `agentrail agent create/connect` wraps
the API key and profile calls described below, writes `.agentrail/agent.env`,
and verifies that the generated key can call `/tasks/mine`.

Create the first admin key:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/agent-api-keys" \
  -H "content-type: application/json" \
  -H "idempotency-key: bootstrap-admin-v1" \
  -d '{
    "agent": {
      "id": "agt_cto",
      "displayName": "CTO",
      "role": "cto"
    },
    "scopes": ["auth:admin"],
    "rateLimit": {
      "windowSeconds": 60,
      "maxRequests": 600
    }
  }'
```

The response returns `data.apiKey` once. Store that secret in the agent runtime
or secret manager. The `data.id` value starts with `akey_` and is only the key
identifier.

Recommended scopes:

| Agent responsibility | Minimum scopes |
| --- | --- |
| Read assigned tasks | `tasks:read` |
| Submit completed work | `tasks:read`, `tasks:write` |
| Inspect CI | `ci:read` |
| Inspect review feedback | `reviews:read` |
| Ship or roll back | `ship:write` |
| Stream task events | `events:read` |
| Manage webhooks | `webhooks:read`, `webhooks:write` |
| Manage API keys | `auth:admin`, `usage:read` |

## Live GitHub and CI Adapters

The local demo is deterministic only in explicit demo mode. To connect task
lifecycle calls to live providers, configure task sources and provider tokens
before starting the default server.

```bash
export GITHUB_TOKEN=ghp_...
export CIRCLECI_TOKEN=...
export CIRCLECI_WEBHOOK_SECRET=...
export AGENTRAIL_TASK_SOURCES='{
  "tsk_live_example": {
    "ciProvider": "circleci",
    "owner": "oxnw",
    "repo": "agentrail",
    "projectSlug": "gh/oxnw/agentrail",
    "branch": "main",
    "headSha": "abc123",
    "submissionId": "sub_live_001"
  }
}'
npm start
```

Provider behavior:

- `GITHUB_TOKEN` enables GitHub PR submission and GitHub Actions CI status.
- `CIRCLECI_TOKEN` enables CircleCI status for task sources with
  `ciProvider: "circleci"`.
- `CIRCLECI_WEBHOOK_SECRET` verifies inbound CircleCI webhook requests at
  `POST /providers/circleci/webhooks`.
- If no live adapter matches a task, the route returns `404`; server mode never
  falls back to the deterministic demo task store.

Do not commit provider tokens or generated AgentRail API keys.

## Push Instead of Polling

Agents should avoid blind status polling. Prefer one of these:

- `GET /task-events/stream` for server-sent events with cursor replay.
- `/task-webhook-subscriptions` for signed outbound webhook delivery.

Use polling only as a fallback when the agent runtime cannot receive push
events.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `auth_store_unavailable` from `/agent-api-keys` | You are using `AGENTRAIL_MODE=demo` or another server without an auth store | Use `ar_local_demo_key` for the local demo, or run an auth-enabled server that wires `AgentAuthStore`. |
| `401 Unauthorized` | Auth-enabled server received a missing or wrong bearer key | Use the one-time `data.apiKey` secret, not the `akey_...` id. |
| `403 insufficient_scope` | The key lacks the route's required scope | Create or rotate a key with the minimum required scope. |
| `409 conflict` on submit or ship | The idempotency key was reused with a different body, or the task is not in a valid state | Use a new key for a new attempt, or follow `availableActions`. |
| `503` with `x-agentrail-fallback: true` | Fallback mode is enabled | Set `AGENTRAIL_FALLBACK_MODE=false` and restart. |
| Empty `tasks.data` | No task matches the status filter | Try `status=todo`, remove the filter, or check the task assignment source. |
| CI stays pending | No live CI adapter is configured for the task | Set `GITHUB_TOKEN` or `CIRCLECI_TOKEN` and verify `AGENTRAIL_TASK_SOURCES`. |

## Related Documentation

- [Five-minute quick start](./quick-start.md)
- [Agent recipes](./agent-recipes.md)
- [Cloud boundary](./cloud.md)
- [Local and self-hosted setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md)
- [OpenAPI contract](./api/task-lifecycle.openapi.yaml)
- [End-to-end demo](./demo/agentrail-e2e-demo.md)
- [Claude Code and Codex lifecycle example](../examples/issue-to-pr-lifecycle.md)
- [Railway production runbook](./deployment/railway-production.md)
- [Live sandbox validation gate](./deployment/live-sandbox-validation.md)

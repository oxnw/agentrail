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
If you want to bootstrap a local self-hosted setup quickly, start with the
[five-minute quick start](./quick-start.md). If you want copy-paste agent
instructions for Claude Code, Codex, or Cursor, use
[agent recipes](./agent-recipes.md).

The current onboarding path exists to close the routing bootstrap described in
[AGEA-95](/AGEA/issues/AGEA-95) and the integration-doc clarity gap called out
in [AGEA-93](/AGEA/issues/AGEA-93).

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

## Current / Legacy / Planned Capability Labels

This repository mixes working OSS runtime paths with operator contracts for the
planned control plane. Use these labels when deciding what an integration can
rely on today:

| Capability | Current live adapter support | Legacy demo note | Planned MVP control-plane behavior |
| --- | --- | --- | --- |
| Intake | **Current:** Provider intake is documented in the routing OpenAPI, but the OSS server does not yet run a live provider intake worker. | **Legacy:** The removed demo used a pre-seeded task instead of ingesting a provider issue. | **Planned:** The control plane receives or pulls provider issue snapshots and normalizes them into AgentRail task candidates. |
| Routing | **Current:** Routing rules, dry-run evaluation, assignment, and audit are implemented as operator/admin contracts; `AGENTRAIL_ROUTING_AUDIT_STORE_PATH` persists decisions and evaluation/intake idempotency replay locally. | **Legacy:** The removed demo skipped routing by starting with a pre-assigned task. | **Planned:** Hosted control-plane deployments evaluate deterministic rules, store `routingReason`, wake the selected agent, and expose managed audit history. |
| Auth | **Current:** Agent API key creation, scopes, rate limits, and route enforcement are implemented on the default server path. | **Legacy:** Placeholder demo keys are no longer valid on the core runtime. | **Planned:** Hosted control-plane deployments issue least-privilege scoped keys per agent and expose operator rotation workflows. |
| Local/self-hosted setup | **Current:** `agentrail init` writes local `.agentrail` scaffolding and operator bootstrap state, `agentrail agent create` creates scoped local agent credentials/profile/routing, and `agentrail doctor` verifies health, auth, profile/routing state, and `/tasks/mine` visibility. | **Legacy:** The removed demo runtime used a built-in fixture task instead of explicit task-store configuration. | **Planned:** Hosted setup will wrap the same identity/profile/routing concepts in a managed team onboarding service. |
| Live task store | **Current:** The server reads durable task records from `AGENTRAIL_TASK_STORE_PATH`, can persist routing audit records through `AGENTRAIL_ROUTING_AUDIT_STORE_PATH`, and never falls back to hidden fixture data. | **Legacy:** The removed demo used an in-memory deterministic lifecycle store. | **Planned:** The control plane persists assigned tasks, routing decisions, lifecycle state, and event cursors in managed storage. |
| Submit | **Current:** `mode: "adapter_managed"` lets the GitHub submit adapter create or reuse provider PRs from persisted `task.source` metadata. | **Legacy:** Artifact-style placeholder PR examples remain documentation-only; they are not a runtime mode. | **Planned:** Submit is always mediated by provider adapters, with idempotent create-or-reuse behavior and compact response state. |
| CI / review | **Current:** GitHub Actions, CircleCI, and GitHub review feedback adapters expose compact status summaries from persisted `task.source` metadata. | **Legacy:** The removed demo simulated CI and review transitions locally. | **Planned:** The control plane stores provider status snapshots, emits task events, and prefers push delivery over agent polling. |
| Ship | **Current:** Ship and rollback routes are implemented behind adapter interfaces with idempotency keys and common state/error handling. | **Legacy:** The removed demo returned a deterministic queued ship result. | **Planned:** Managed control-plane deployments coordinate merge, deploy, rollback, and audit with least-privilege provider permissions. |

## First-Time Routing Bootstrap

The first routing rule is not created by a worker agent and it is not inferred
only from GitHub labels.

Current OSS/server model:

- A trusted operator or setup script first creates the `AgentProfile` for the
  new `agentId`.
- That same setup path then creates the initial routing rule set through
  `PUT /operator/routing/rule-sets/current`.
- The first rule should stay narrow: target the new `agentId` only for the
  selected repo allowlist and capability tags, with triage as the fallback.
- After that, AgentRail seeds or ingests one setup verification task through
  the normal assignment path so the new agent can prove it can read its task.

Current CLI-assisted model:

- `agentrail init` gathers repo/base URL defaults, writes local setup files, and
  creates local operator bootstrap state.
- `agentrail agent create` creates the scoped agent key, `AgentProfile`, starter
  routing state, and managed agent env file.
- `agentrail doctor` uses the generated agent key plus operator state to verify
  that the bootstrap produced visible assigned work.

Why it works this way:

- Routing is control-plane configuration, not worker-owned behavior.
- AgentRail needs an auditable initial rule-set revision before the first real
  task arrives, so later ownership changes remain data changes instead of code
  edits.
- Starting with one narrow bootstrap rule keeps the first assignment
  deterministic while still leaving a safe triage fallback for anything the
  setup flow did not cover.

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
persisted `task.source` metadata, and the response can include `prUrl`, `prNumber`, and
whether the PR was created or reused.

Local deterministic examples may still show placeholder PR artifacts so the
demo can run without provider credentials. Do not model production automation
on a human pasting a PR URL into AgentRail.

## Choose an Integration Track

### Track A: Local Self-Hosted Bootstrap

Use this when you want to run the real server locally with CLI-managed config,
agent credentials, routing, and provider state. The default path is:

1. Run `agentrail init`.
2. Start the server with `agentrail server start`.
3. Create or connect the first local agent with `agentrail agent create` if
   `init` did not already do it interactively.
4. Finish with `agentrail doctor`.

The copy-paste version of that flow lives in the
[five-minute quick start](./quick-start.md). Raw lifecycle curls are developer
reference material after doctor passes.

```bash
npm install -g @agentrail-core/cli
agentrail init
agentrail server start
```

In a second terminal:

```bash
agentrail agent create
agentrail doctor
```

Cloud boundary note: Track A proves the local lifecycle contract. It does not
include managed provider connectors, team access control, audited fleet routing,
dashboards, support, compliance, backups, or hosted reliability.

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
export AGENTRAIL_API_KEY=ar_live_replace_with_real_key
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
  apiKey: process.env.AGENTRAIL_API_KEY!,
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
        api_key=os.environ["AGENTRAIL_API_KEY"],
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

Agent auth is supported on the default server path. The first bootstrap request
creates an `auth:admin` key, and subsequent task routes require the returned
secret `data.apiKey`.

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
lifecycle calls to live providers, configure provider tokens before starting
the default server. Live adapters read persisted `task.source` metadata from
the task record; if an older task is missing required source fields, repair it
through the operator API or `agentrail task source repair`.

```bash
export GITHUB_TOKEN=ghp_...
export CIRCLECI_TOKEN=...
export CIRCLECI_WEBHOOK_SECRET=...
npm start
```

Provider behavior:

- `GITHUB_TOKEN` enables GitHub PR submission and GitHub Actions CI status.
- `CIRCLECI_TOKEN` enables CircleCI status for tasks with
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
| `auth_store_unavailable` from `/agent-api-keys` | The server was started without auth wiring or an older runtime is still running | Restart with the current default server entrypoint and retry the bootstrap request. |
| `401 Unauthorized` | Auth-enabled server received a missing or wrong bearer key | Use the one-time `data.apiKey` secret, not the `akey_...` id. |
| `403 insufficient_scope` | The key lacks the route's required scope | Create or rotate a key with the minimum required scope. |
| `409 conflict` on submit or ship | The idempotency key was reused with a different body, or the task is not in a valid state | Use a new key for a new attempt, or follow `availableActions`. |
| `503` with `x-agentrail-fallback: true` | Fallback mode is enabled | Set `AGENTRAIL_FALLBACK_MODE=false` and restart. |
| Empty `tasks.data` | No task matches the status filter | Try `status=todo`, remove the filter, or check the task assignment source. |
| CI stays pending | No live CI adapter is configured for the task, or the task is missing persisted source metadata | Set `GITHUB_TOKEN` or `CIRCLECI_TOKEN`, then inspect or repair `task.source`. |

## Related Documentation

- [Five-minute quick start](./quick-start.md)
- [Agent recipes](./agent-recipes.md)
- [Cloud boundary](./cloud.md)
- [Local and self-hosted setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md)
- [OpenAPI contract](./api/task-lifecycle.openapi.yaml)
- [Self-hosted task store example](../examples/self-hosted-task-store.json)
- [Claude Code and Codex lifecycle example](../examples/issue-to-pr-lifecycle.md)
- [Railway production runbook](./deployment/railway-production.md)

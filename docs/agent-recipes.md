# AgentRail Recipes for Coding Agents

These recipes show how Claude Code, Codex, and Cursor can use AgentRail as the source of truth for issue -> PR -> CI -> review -> ship.

All recipes use the same local API:

```bash
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=${AGENTRAIL_API_KEY:-ar_local_demo_key}
```

Start AgentRail first:

```bash
docker compose up --build
```

## Shared SDK Probe

Install the TypeScript SDK in the workspace where the agent runs:

```bash
npm install @agentrail-core/sdk
```

Verify the agent can read its first task:

```bash
node --input-type=module <<'JS'
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

const tasks = await client.listMyTasks({ status: "in_progress", limit: 1 });
const task = tasks.data[0];

if (!task) {
  console.log("No in-progress AgentRail task is assigned.");
  process.exit(0);
}

console.log(JSON.stringify({
  id: task.id,
  identifier: task.identifier,
  title: task.title,
  status: task.status,
  availableActions: task.availableActions,
}, null, 2));
JS
```

Expected local demo task:

```json
{
  "id": "tsk_DEMOISSUETOSHIP01",
  "identifier": "AGEA-10-DEMO",
  "status": "in_progress",
  "availableActions": ["submit"]
}
```

## Claude Code Recipe

### Install SDK

```bash
npm install @agentrail-core/sdk
```

### Configure

Add this to the project instructions Claude Code reads for the workspace:

```md
Use AgentRail for task lifecycle state.

- Base URL: `AGENTRAIL_BASE_URL`
- API key: `AGENTRAIL_API_KEY`
- Start by listing one in-progress task with the AgentRail SDK.
- Treat `availableActions` as the allowed next operations.
- After code changes and tests, call `submitTask` with an idempotency key and PR/commit artifacts.
- Read CI and review through AgentRail before deciding whether to resubmit or ship.
- Prefer SSE or webhooks over blind polling when waiting for state changes.
```

### Run First Task

Prompt Claude Code:

```text
Use AgentRail. Read the first in-progress task, inspect its availableActions, do the requested code work locally, run the smallest relevant tests, submit the PR/commit artifacts with an idempotency key, then read AgentRail CI and review feedback before deciding whether to resubmit or ship.
```

Minimal SDK call Claude Code should make first:

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

const tasks = await client.listMyTasks({ status: "in_progress", limit: 1 });
const task = tasks.data[0];
```

## Codex Recipe

### Install SDK

```bash
npm install @agentrail-core/sdk
```

### Configure

Add this section to `AGENTS.md` in the target repo:

```md
## AgentRail

Use AgentRail as the lifecycle source of truth.

- `AGENTRAIL_BASE_URL` points to the API.
- `AGENTRAIL_API_KEY` contains the agent key.
- First action: `listMyTasks({ status: "in_progress", limit: 1 })`.
- Mutations must include idempotency keys.
- Submit artifacts must include PR and commit URLs when available.
- Read `/ci-status` and `/review-feedback` before resubmitting or shipping.
- Use `availableActions`; do not infer hidden task states.
```

### Run First Task

Prompt Codex:

```text
You are working through AgentRail. Use the TypeScript SDK to list the first in-progress task, follow availableActions, make the code change locally, verify it, submit artifacts with an idempotency key, then read CI and review feedback before any ship request.
```

For a direct local demo run, use the curl lifecycle in [Quick Start](./quick-start.md#first-task-lifecycle).

## Cursor Recipe

### Install SDK

```bash
npm install @agentrail-core/sdk
```

### Configure

Create a Cursor rule in `.cursor/rules/agentrail.mdc`:

```md
---
description: Use AgentRail for assigned engineering work
alwaysApply: true
---

When the user asks you to work an assigned task, use AgentRail first.

- Read `AGENTRAIL_BASE_URL` and `AGENTRAIL_API_KEY` from the environment.
- Use `@agentrail-core/sdk`.
- Start with `listMyTasks({ status: "in_progress", limit: 1 })`.
- Use `availableActions` to choose submit, view_ci_status, view_review_feedback, or ship.
- Include idempotency keys for submit and ship.
- Include PR/commit artifacts in submissions.
- Prefer AgentRail task events or webhooks instead of polling raw providers.
```

### Run First Task

In Cursor Agent chat, use:

```text
Use AgentRail for this task. Start by listing the first in-progress AgentRail task with the SDK, inspect availableActions, implement the requested change, run focused tests, submit artifacts, and read AgentRail CI/review feedback before deciding whether to resubmit or ship.
```

## Submit and Ship with the SDK

After the coding agent has made local changes, opened a PR, and run tests, it should submit with a fresh idempotency key:

```ts
await client.submitTask(
  task.id,
  {
    summary: "Implemented the requested change and opened a pull request.",
    artifacts: [
      { type: "pull_request", url: "https://github.com/org/repo/pull/42" },
      { type: "commit", url: "https://github.com/org/repo/commit/b5bc7f86" },
    ],
    checks: [{ name: "unit-tests", status: "passed" }],
  },
  `submit-${task.id}-${Date.now()}`,
);
```

Then read CI and review:

```ts
const ci = await client.getTaskCiStatus(task.id);
const review = await client.getTaskReviewFeedback(task.id);
```

Ship only when AgentRail says both are green:

```ts
const expectedHeadSha =
  process.env.AGENTRAIL_EXPECTED_HEAD_SHA ??
  "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0";

if (
  ci.data.overallStatus === "passed" &&
  review.data.latestDecision.outcome === "approved" &&
  review.availableActions.includes("ship")
) {
  await client.shipTask(
    task.id,
    {
      mode: "merge_and_deploy",
      targetEnvironment: "production",
      expectedHeadSha,
    },
    `ship-${task.id}-${Date.now()}`,
  );
}
```

## Operational Notes

- Give agents the narrowest API key scopes they need: `tasks:read`, `tasks:write`, `ci:read`, `reviews:read`, and `ship:write` only for shippers.
- Use one idempotency key per distinct submit or ship attempt.
- Keep task response payloads in context and avoid fetching raw provider logs unless AgentRail points to a specific failure.
- For long waits, use `client.streamEvents()` or webhook subscriptions instead of polling.

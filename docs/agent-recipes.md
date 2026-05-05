# AgentRail Agent Recipes

These instructions are for coding agents operating inside a target repository.
AgentRail is the lifecycle source of truth. The agent still edits files, runs
tests, commits, pushes, and opens PRs with its normal tools.

## Shared Agent Contract

Use AgentRail for task lifecycle state.

Environment:

- `AGENTRAIL_BASE_URL` defaults to `http://127.0.0.1:3000`.
- `AGENTRAIL_API_KEY` must be the secret `data.apiKey` value returned by
  AgentRail, not the `akey_...` id.

Operating rules:

- Start by calling `GET /tasks/mine?status=in_progress&limit=1`.
- If no task is returned, try `status=todo` before stopping.
- Treat `availableActions` as authoritative.
- Do not submit, ship, or roll back unless the action is present.
- Use a fresh idempotency key for every distinct submit, ship, or rollback
  attempt.
- Reusing the same idempotency key with the same payload is safe.
- Reusing the same idempotency key with a different payload is a bug and should
  be treated as a `409 conflict`.
- Prefer task events or webhooks over blind polling.
- Keep AgentRail submission summaries compact and action-oriented.
- Include PR and commit URLs in `artifacts` when available.
- In production automation, prefer AgentRail adapter-managed submit: AgentRail
  should create or reuse the provider PR and return the PR URL.
- If `x-agentrail-fallback: true` is returned, switch to direct provider APIs
  for the current task and report that fallback mode was used.

Minimal HTTP headers:

```text
authorization: Bearer $AGENTRAIL_API_KEY
content-type: application/json
idempotency-key: <operation-task-attempt>
```

## Claude Code

Install Claude Code using Anthropic's current CLI installation path, then start
it in the target repository.

```bash
npm install -g @anthropic-ai/claude-code
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=ar_live_replace_with_real_key
claude --append-system-prompt-file /path/to/agentrail/docs/agent-recipes.md
```

First user prompt:

```text
Work through AgentRail.

Begin with:
GET $AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1

Use AgentRail availableActions for lifecycle decisions. Edit code in this
repository, run the smallest relevant tests, submit with an idempotency key,
read CI and review feedback, resubmit if needed, and ship only when AgentRail
says ship is available.
```

Claude Code should keep repository work local to the target checkout. AgentRail
does not tell Claude which files to edit; it tells Claude which lifecycle action
is valid next.

## Codex

Start Codex in the target repository with the same environment:

```bash
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=ar_live_replace_with_real_key
codex
```

Add this to the task prompt:

```text
You are working through AgentRail.

Source of truth:
- GET $AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1
- GET $AGENTRAIL_BASE_URL/tasks/{taskId}
- POST $AGENTRAIL_BASE_URL/tasks/{taskId}/submit
- GET $AGENTRAIL_BASE_URL/tasks/{taskId}/ci-status
- GET $AGENTRAIL_BASE_URL/tasks/{taskId}/review-feedback
- POST $AGENTRAIL_BASE_URL/tasks/{taskId}/ship

Follow availableActions. Use idempotency keys for every mutation. Prefer push
events over polling when available. Keep final updates concise and include how
to verify the work.
```

## Cursor

Put the shared contract into a project rule or the agent's instruction field in
the target repository.

Suggested rule text:

```text
This repository is worked through AgentRail.

Before choosing implementation work, query:
GET $AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1

Use AgentRail's availableActions to decide whether to submit, inspect CI, read
review feedback, resubmit, ship, or stop. Mutating requests must include a
fresh idempotency key. Do not poll blindly; use events or webhooks when the
runtime supports them.
```

## TypeScript Harness Recipe

Use this when the agent is driven by your own Node.js service rather than by a
human typing prompts into a CLI.

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const apiKey = process.env.AGENTRAIL_API_KEY;
if (!apiKey) {
  throw new Error("Set AGENTRAIL_API_KEY before starting the harness.");
}

const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey,
});

const tasks = await client.listMyTasks({ status: "in_progress", limit: 1 });
const task = tasks.data[0];

if (!task) {
  process.exit(0);
}

if (task.availableActions.includes("submit")) {
  const demoPrUrl = "https://github.com/oxnw/agentrail/pull/42";
  await client.submitTask(
    task.id,
    {
      summary: "Implemented the assigned change and opened a PR.",
      artifacts: [
        { type: "pull_request", url: demoPrUrl },
      ],
    },
    `submit-${task.id}-${Date.now()}`,
  );
}
```

## Python Harness Recipe

```py
import asyncio
import os
import time

from agentrail import AgentRailClient, ArtifactType, SubmitArtifact, TaskStatus
from agentrail import TaskSubmitRequest


async def main():
    api_key = os.getenv("AGENTRAIL_API_KEY")
    if not api_key:
        raise ValueError("Set AGENTRAIL_API_KEY before starting the harness.")

    async with AgentRailClient(
        base_url=os.getenv("AGENTRAIL_BASE_URL", "http://127.0.0.1:3000"),
        api_key=api_key,
    ) as client:
        tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS, limit=1)
        if not tasks.data:
            return

        task = tasks.data[0]
        demo_pr_url = "https://github.com/oxnw/agentrail/pull/42"
        await client.submit_task(
            task.id,
            TaskSubmitRequest(
                summary="Implemented the assigned change and opened a PR.",
                artifacts=[
                    SubmitArtifact(
                        type=ArtifactType.PULL_REQUEST,
                        url=demo_pr_url,
                    )
                ],
            ),
            idempotency_key=f"submit-{task.id}-{int(time.time())}",
        )


asyncio.run(main())
```

## Failure Handling

| Failure | Agent response |
| --- | --- |
| Empty task list | Stop after checking `in_progress` and `todo`; do not invent work. |
| `401 Unauthorized` | Report that the runtime has the wrong API key. |
| `403 insufficient_scope` | Report the missing scope from the error body. |
| `409 conflict` on mutation | Do not retry with a changed payload and same key; inspect current task state. |
| CI failed | Read failure summaries, fix locally, submit a new attempt. |
| Review changes requested | Apply review comments, run tests, submit a new attempt. |
| Ship rejected for SHA mismatch | Refresh task state before attempting ship again. |
| Fallback mode | Use direct GitHub or CI APIs and mention fallback in the final summary. |

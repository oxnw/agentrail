# AgentRail Agent Recipes

These instructions are for coding agents operating inside a target repository.
AgentRail is the lifecycle source of truth. In the managed local runner flow,
AgentRail waits for assignments and provider status, starts the coding agent
only when code work is required, and consumes the agent's local report when the
work is done.

## Shared Agent Contract

Use AgentRail for lifecycle state, but do not make the child LLM discover or
poll broad lifecycle state.

Managed runner environment:

- `AGENTRAIL_RUN_REPORT_PATH` points to the local report file consumed by
  AgentRail after the child process exits.
- `AGENTRAIL_HANDOFF_PATH` points to the structured handoff file.
- `AGENTRAIL_RUN_CONTEXT_PATH` points to the current run context snapshot.
- `AGENTRAIL_TASK_ID` and `AGENTRAIL_TASK_IDENTIFIER` identify the assigned
  work already selected by AgentRail.

Operating rules:

- Use only run-scoped AgentRail commands from the child process:
  `agentrail run current`, `agentrail run actions`, and
  `agentrail agent report`.
- Do not call broad AgentRail task, CI, review, ship, rollback, provider, or
  operator endpoints from the child LLM.
- Work only inside the provided git worktree.
- Run the smallest relevant validation before reporting completion.
- Commit locally when code changed.
- Report progress, completion, or blockers with `agentrail agent report`.
- Use `target: "agentrail"` when AgentRail should publish and continue the
  lifecycle.
- Use `target: "user"` when user intervention is required.

To inspect the current assignment:

```bash
agentrail run current
agentrail run actions
```

## Claude Code

Normal local operation starts with `agentrail server start`, which keeps
managed local agents awake. The command below is still useful when debugging a
single Claude Code run:

```bash
cd /path/to/target-repo
agentrail agent run --agent-id agt_runner --once
```

The prompt passed by AgentRail already contains the assigned task. Claude should
edit code, run focused validation, write the handoff file, and report. If it
needs to re-read the current assignment, it may use `agentrail run current` or
`agentrail run actions`.

```text
agentrail agent report --status completed --summary "short completion summary" --handoff-file "$AGENTRAIL_HANDOFF_PATH"
```

## Codex

The same server-owned wake flow applies to Codex. Use the command below only
when debugging a single Codex run outside the server supervisor:

```bash
cd /path/to/target-repo
agentrail agent run --agent-id agt_runner --once
```

The child Codex process receives a compact task prompt and reports locally. It
may call `agentrail run current` or `agentrail run actions` if it needs to
re-read its current assignment. Those commands are scoped to the current run
and do not expose task lists or provider credentials.

```text
agentrail agent report --status progress --summary "short update"
```

## Cursor

Cursor should be launched by AgentRail or opened from an AgentRail-created
worktree. The rule should keep Cursor focused on repository work:

Suggested rule text:

```text
This repository is worked through AgentRail. AgentRail has already assigned the
task and owns lifecycle state. If you need to inspect the current assignment,
use `agentrail run current` or `agentrail run actions`. Do not call broad
AgentRail task, CI, review, ship, rollback, provider, or operator endpoints.
Edit code in the provided worktree, validate the change, commit locally, write
the handoff file, and report with `agentrail agent report`.
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

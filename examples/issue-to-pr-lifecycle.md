# Claude Code and Codex Issue-to-PR Lifecycle

This example shows how a coding agent should use AgentRail to move from an
assigned issue to a reviewed PR and ship request.

Local API base URL:

```text
http://127.0.0.1:3000
```

Demo task:

```text
tsk_DEMOISSUETOSHIP01
```

## Agent Prompt Pattern

Use this shape for Claude Code, Codex, or another coding agent:

```text
You are working through AgentRail.

Base URL: http://127.0.0.1:3000
Task selection: GET /tasks/mine?status=in_progress&limit=1

Rules:
- Use the AgentRail task as the source of truth for next actions.
- Submit work with an Idempotency-Key.
- Read /ci-status and /review-feedback before deciding whether to resubmit or ship.
- Do not poll blindly; prefer task events or webhooks when available.
- Keep PR and commit artifacts in the AgentRail submission payload.
```

## Lifecycle Calls

1. List assigned work:

```bash
curl -s 'http://127.0.0.1:3000/tasks/mine?status=in_progress&limit=1'
```

2. Submit the first PR attempt:

The PR URL below is a placeholder example. Real automation should
prefer adapter-managed submit, where AgentRail creates or reuses the provider PR
and returns the PR URL through lifecycle state.

```bash
curl -s -X POST 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/submit' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: submit-demo-1' \
  -d '{
    "summary": "Implemented the endpoint and opened a pull request.",
    "mode": "artifact",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" }
    ],
    "checks": [{ "name": "unit-tests", "status": "failed" }],
    "notes": "First pass demonstrates the feedback loop."
  }'
```

3. Read concise CI state:

```bash
curl -s 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/ci-status'
```

4. Read review feedback:

```bash
curl -s 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/review-feedback'
```

5. Resubmit after the fix:

```bash
curl -s -X POST 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/submit' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: submit-demo-2' \
  -d '{
    "summary": "Fixed idempotency handling and added regression coverage.",
    "mode": "artifact",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" },
      { "type": "commit", "url": "https://github.com/oxnw/agentrail/commit/b5bc7f86" }
    ],
    "checks": [{ "name": "unit-tests", "status": "passed" }]
  }'
```

6. Ship after CI and review are green:

```bash
curl -s -X POST 'http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/ship' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: ship-demo-1' \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
  }'
```

## Why This Beats Raw GitHub CLI Calls

With raw GitHub and CI calls, agents must discover issue state, PR state, check
runs, review comments, mergeability, deployment state, and retry semantics from
separate APIs. AgentRail collapses that into bounded task lifecycle responses
with explicit next actions and retry-safe mutations.

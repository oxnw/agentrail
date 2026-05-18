# AgentRail Developer Guide

This guide keeps lower-level implementation and API reference material out of
the README. Start with the README if you only want to run AgentRail locally.

## Requirements

- Node.js 24 or newer.
- `npm`, `git`, and `curl`.
- Docker Desktop if you want to run the compose smoke path.
- Provider credentials only when testing live provider adapters.

## Local Development

Install dependencies:

```bash
npm install
npm link
```

Run checks:

```bash
npm run typecheck
npm test
npm run lint:openapi
```

Start the local API from a configured checkout:

```bash
agentrail server start
```

You can also run the raw server entrypoint for development:

```bash
npm start
```

The package exposes the `agentrail` binary. In a source checkout, use
`npm link` or `npm install -g .` once if the binary is not already on your
`PATH`.

## Runtime Model

The repository is intentionally API-first:

- `src/app.ts` exposes HTTP routes.
- `src/server-runtime.ts` wires stores, adapters, routing, providers, and
  background delivery.
- `src/task-store.ts` stores task lifecycle state.
- `src/task-event-store.ts` stores and replays compact task events.
- `src/event-subscription-store.ts` and `src/event-delivery-worker.ts` model
  event subscriptions and delivery retry state.
- `src/github-issue-intake-adapter.ts` and
  `src/linear-issue-source-adapter.ts` ingest provider issues.
- `src/intake-routing-control-plane.ts` owns routing profiles, rule sets,
  decisions, and audit entries.
- `sdk/typescript` and `sdk/python` are the typed SDK surfaces agents should use
  instead of hand-rolled HTTP calls.

The runtime does not silently fall back to fixture tasks. Provider imports are
expected to route through configured routing state or fail closed.

## Provider Configuration

Provider adapters are opt-in:

- `GITHUB_TOKEN` enables GitHub-backed submit, CI, review, and issue intake
  paths where configured.
- `CIRCLECI_TOKEN` enables CircleCI status lookup for tasks with
  `ciProvider: "circleci"`.
- `CIRCLECI_WEBHOOK_SECRET` verifies CircleCI webhook deliveries.
- `LINEAR_API_KEY` enables Linear issue import and outbound GraphQL mutations.
- `LINEAR_WEBHOOK_SECRET` verifies Linear webhook deliveries.

Prefer the CLI for local setup:

```bash
agentrail provider connect github
agentrail provider connect circleci

# Paste the full CircleCI project slug when prompted:
# circleci/<org-id>/<project-id>
agentrail provider connect linear
```

The CLI writes local provider env files and masks secret prompts.

## AI Routing Configuration

AgentRail routing has two setup modes:

- `rules_only`: deterministic rules route or triage work. No model is called.
- `ai_assist`: AgentRail can use AI to route tasks to the right agents.
  If AI routing cannot find a suitable agent, setup can require a suitable
  agent and retry when agents change, or assign the closest match as a
  best-effort decision.

AI routing uses the same local runner family as managed agents. It does not
require provider API keys for LLM calls in this repo. Configure it during init:

```bash
agentrail init \
  --routing-mode ai-assist \
  --routing-classifier-runner codex \
  --routing-classifier-model gpt-5.4-mini
```

Supported local AI routing runner executables:

| Runner | Executable checked by doctor | Notes |
| --- | --- | --- |
| `codex` | `codex` | Runs the AI routing prompt through the local Codex CLI. |
| `claude-code` | `claude` | Uses Claude Code's local CLI. |
| `cursor` | `cursor-agent` | Requires the Cursor agent CLI, not only the GUI app. |

`agentrail doctor` verifies the configured executable is on `PATH`, but it does
not make a model call. Runtime AI routing receives bounded issue text only:
title, labels, repo, project, issue type, priority, and a truncated body
preview. Local runner classification defaults to a 180 second timeout; slow
local runners can raise `routing.classifier.timeoutMs` in `config.json` up to
600 seconds. Timeout failures leave the task for triage instead of forcing an
unsafe assignment.

## API Contracts

- [Task lifecycle OpenAPI](./api/task-lifecycle.openapi.yaml)
- [Intake routing admin OpenAPI](./api/intake-routing-admin.openapi.yaml)
- [Intake routing architecture](./architecture/intake-routing-engine.md)
- [Local setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md)

## Manual HTTP Reference

The CLI should be the normal onboarding path. These calls are useful when
testing the API directly or debugging setup state.

Create an operator-capable key:

```bash
curl -s -X POST http://127.0.0.1:3000/agent-api-keys \
  -H "content-type: application/json" \
  -H "idempotency-key: bootstrap-local-admin" \
  -d '{
    "agent": {
      "id": "agt_local_operator",
      "displayName": "Local Operator",
      "role": "operator"
    },
    "scopes": [
      "auth:admin",
      "routing:admin",
      "routing:read",
      "tasks:read",
      "tasks:write",
      "usage:read"
    ]
  }'
```

The returned `data.apiKey` is the secret bearer token. The `akey_...` value is
the key id, not the secret.

List assigned work for an agent key:

```bash
curl -s "http://127.0.0.1:3000/tasks/mine?status=in_progress&limit=1" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Submit work for review:

```bash
curl -s -X POST "http://127.0.0.1:3000/tasks/tsk_example/submit" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: submit-example-1" \
  -d '{
    "summary": "Implemented the assigned change.",
    "mode": "adapter_managed",
    "pullRequest": {
      "title": "Implement assigned AgentRail task",
      "draft": false
    }
  }'
```

Read CI and review feedback:

```bash
curl -s "http://127.0.0.1:3000/tasks/tsk_example/ci-status" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"

curl -s "http://127.0.0.1:3000/tasks/tsk_example/review-feedback" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

## SDK Examples

TypeScript:

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY!,
});

const tasks = await client.listMyTasks({ status: "in_progress" });
```

Python:

```py
import os
from agentrail import AgentRailClient, TaskStatus

async with AgentRailClient(
    base_url="http://127.0.0.1:3000",
    api_key=os.environ["AGENTRAIL_API_KEY"],
) as client:
    tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS)
```

## Docker

Build and run the local server image:

```bash
docker build -t agentrail .
docker run --rm -p 3000:3000 agentrail
```

Or use compose:

```bash
docker compose up --build
```

Docker starts the server. Use the CLI setup path when you need local agent,
routing, and provider state.

## Release Boundary

This public repo is the source-available runtime: local server, CLI, SDKs,
provider adapters, OpenAPI contracts, and self-managed setup docs.

AgentRail Cloud is planned as the managed team/fleet layer, not merely a hosted
copy of this Node process. Cloud should own managed connectors, shared run
history, routing and wakes, SSO/RBAC/SCIM, audit, dashboards, support,
backups, and hosted reliability. See [Cloud boundary](./cloud.md).

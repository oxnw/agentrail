# AgentRail

[![CI](https://github.com/oxnw/agentrail/actions/workflows/ci.yml/badge.svg)](https://github.com/oxnw/agentrail/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen)](https://nodejs.org/)

AgentRail is an agent-native developer operations API for the full project
lifecycle: issue -> PR -> CI -> review -> ship.

The MVP in this repository is a local, deterministic release candidate that
lets coding agents such as Claude Code, Codex, Cursor, and Devin complete a
task through one compact API instead of stitching together raw GitHub, Linear,
CI, review, and deployment calls.

AgentRail OSS is intentionally runnable as a local or self-managed
single-instance product. The planned AgentRail Cloud product is the managed
team and fleet operations layer: hosted connector operations, durable shared run
history and memory, routing and wakes, SSO/RBAC/SCIM, audit, dashboards,
support, compliance, and hosted reliability.

## Why Agents Need It

Raw developer tools are built for humans. They expose broad resources, verbose
logs, ambiguous next steps, and state changes that agents must discover by
polling. That wastes context window budget and creates brittle retry behavior.

AgentRail gives agents:

- Compact task state with `availableActions` on every response.
- Retry-safe mutating operations through idempotency keys.
- CI and review summaries shaped for action, not full log replay.
- Push-first task events over SSE and webhooks.
- Least-privilege agent API keys and usage attribution.
- Adapter boundaries for GitHub, Linear, CI, review, and deployment systems.

## Quickstart

Prerequisite: Node.js 22.6 or newer, or Docker Desktop with Docker Compose.

One-command Docker setup:

```bash
git clone https://github.com/oxnw/agentrail.git && cd agentrail && docker compose up --build
```

The local API starts on `http://127.0.0.1:3000` by default. Docker Compose
persists task event stream replay data in the `agentrail-event-data` volume.
This is self-managed OSS, not a Cloud-equivalent managed team control plane.

Node setup:

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
cp .env.example .env
npm install
cp examples/self-hosted-task-store.json .agentrail.tasks.json
cp examples/self-hosted-task-sources.json .agentrail.task-sources.json
```

Edit the copied example files so the repository owner, repo, issue number,
branch, and assignee match your local setup. Then start the server with real
GitHub credentials:

```bash
export GITHUB_TOKEN=ghp_your_token
export AGENTRAIL_TASK_STORE_PATH=$PWD/.agentrail.tasks.json
export AGENTRAIL_TASK_SOURCES="$(cat .agentrail.task-sources.json)"
npm start
```

Current local setup is manual. The planned self-hosted setup CLI contract is
documented in
[docs/architecture/local-self-hosted-setup-cli-contract.md](docs/architecture/local-self-hosted-setup-cli-contract.md):
`agentrail init` writes local config, `agentrail server start` starts the
configured server, and `agentrail agent create/connect` creates the
AgentIdentity, scoped key, AgentProfile, and starter routing state needed
for an LLM agent to call `/tasks/mine`.

Bootstrap the first admin API key:

```bash
curl -s -X POST http://127.0.0.1:3000/agent-api-keys \
  -H 'content-type: application/json' \
  -H 'idempotency-key: bootstrap-local-admin' \
  -d '{
    "agent": {
      "id": "agt_local_agent",
      "displayName": "Local Agent",
      "role": "developer"
    },
    "scopes": [
      "auth:admin",
      "tasks:read",
      "tasks:write",
      "ci:read",
      "reviews:read",
      "ship:write"
    ]
  }'
```

Run tests:

```bash
npm test
```

Docker image:

```bash
docker build -t agentrail .
docker run --rm -p 3000:3000 agentrail
```

## Local API Examples

List the current agent's task:

```bash
export AGENTRAIL_API_KEY=ar_live_replace_with_bootstrap_secret

curl -s http://127.0.0.1:3000/tasks/mine?status=in_progress \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Submit work for review:

```bash
curl -s -X POST http://127.0.0.1:3000/tasks/tsk_SELFHOSTED000000000001/submit \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: submit-local-1' \
  -d '{
    "summary": "Implemented the assigned change.",
    "mode": "adapter_managed",
    "pullRequest": {
      "title": "Validate the self-hosted AgentRail loop",
      "draft": false
    }
  }'
```

Read CI and review feedback:

```bash
curl -s http://127.0.0.1:3000/tasks/tsk_SELFHOSTED000000000001/ci-status \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
curl -s http://127.0.0.1:3000/tasks/tsk_SELFHOSTED000000000001/review-feedback \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

## Architecture

The repository is intentionally API-first:

- `docs/api/task-lifecycle.openapi.yaml` is the public contract.
- `docs/api/intake-routing-admin.openapi.yaml` is the separate operator/admin
  contract for provider issue intake, routing decisions, assignment, and audit.
- `docs/architecture/intake-routing-engine.md` records the routing engine
  boundary and assignment model.
- `src/app.ts` exposes the HTTP routes.
- `src/task-event-store.ts` stores and replays compact lifecycle events.
- `src/task-webhook-store.ts` and `src/task-webhook-delivery-worker.ts` model
  webhook subscriptions and delivery retries.
- `src/github-actions-ci-adapter.ts`, `src/circleci-status-adapter.ts`, and
  `src/github-review-feedback-adapter.ts` show the adapter pattern for external
  developer tools.
- `sdk/typescript` and `sdk/python` are the generated SDK surfaces agents should
  use instead of hand-rolled HTTP calls.

Technical decision: the public MVP is server-only. Local evaluation uses
explicit task-store and task-source examples, while GitHub/CI behavior stays
behind adapter interfaces. The runtime never silently falls back to fixture
tasks.

Rejected: a hosted-only demo. That would make the release depend on paid API
access and would obscure whether the local agent lifecycle contract works.

Rejected: raw GitHub passthrough responses. They are easier to proxy, but they
push summarization, retry semantics, and next-action discovery back onto every
agent.

## Live CI Providers

Provider adapters are opt-in at runtime:

- `GITHUB_TOKEN` enables the GitHub Actions CI adapter for task sources with no
  `ciProvider` or with `ciProvider: "github_actions"`.
- `CIRCLECI_TOKEN` enables the CircleCI CI adapter for task sources with
  `ciProvider: "circleci"` and a CircleCI `projectSlug`.
- `CIRCLECI_WEBHOOK_SECRET` turns on HMAC verification for
  `POST /providers/circleci/webhooks`.

Example `AGENTRAIL_TASK_SOURCES` entry for CircleCI:

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

## SDKs

Create an AgentRail API key and use the returned secret `data.apiKey` value,
which starts with `ar_live_`. The `akey_...` value is the key ID, not the
secret.

TypeScript local usage:

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY!,
});

const tasks = await client.listMyTasks({ status: "in_progress" });
```

Python local usage:

```py
import os
from agentrail import AgentRailClient, TaskStatus

async with AgentRailClient(
    base_url="http://127.0.0.1:3000",
    api_key=os.environ["AGENTRAIL_API_KEY"],
) as client:
    tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS)
```

Non-local base URLs are supported for self-managed or explicitly provisioned
hosted API deployments by passing a `baseUrl` explicitly. That does not mean
AgentRail Cloud is generally available. Local URLs remain the default developer
path for this OSS release candidate.

## Release Scope

This public repo is intentionally limited to the runnable OSS contract: the
local API server, SDKs, self-hosted bootstrap examples, and operator-facing
integration docs.
Internal planning and architecture decision records are kept outside the public
release bundle.

## OSS vs Cloud Boundary

The OSS product should stay fully runnable for local evaluation and
self-managed use. It includes the lifecycle API, SDKs, single-instance server
path, event/webhook primitives, and adapter interfaces.

AgentRail Cloud is planned as the managed team/fleet layer, not merely a hosted
copy of this Node process. Cloud should own managed provider connectors,
governed shared run history and memory, routing and wakes, SSO/RBAC/SCIM,
audit, dashboards, support, compliance, backups, and hosted reliability.

Cloud is not generally available yet. Do not treat hosted URLs, one-click
deploys, or self-hosting instructions as a promise of managed Cloud operations.
See [Cloud boundary](./docs/cloud.md).

## Roadmap

| Status | Feature | Description |
|--------|---------|-------------|
| :white_check_mark: | Task lifecycle API | Issue → PR → CI → review → ship through one typed API |
| :white_check_mark: | GitHub provider adapters | PR submit/reuse, CI status, and review feedback for configured task sources; live merge/ship remains gated by sandbox validation |
| :white_check_mark: | CircleCI adapter | Multi-CI support via pluggable adapter pattern |
| :white_check_mark: | TypeScript & Python SDKs | Typed clients with retry logic, SSE streaming, structured errors |
| :white_check_mark: | Agent auth primitives | Per-agent API key creation, scopes, rate limits, and audit primitives; live runtime wiring remains part of the control-plane work |
| :white_check_mark: | SSE event streams | Real-time task events with cursor replay and filtering |
| :white_check_mark: | Webhook subscriptions | HMAC-signed delivery with retry and backoff |
| :construction: | Ship and rollback primitives | Routes and adapter interfaces with idempotency; live GitHub ship and SDK rollback remain follow-up validation work |
| :construction: | Self-managed deployment | One-click single-instance deploy to Railway or your own infra |
| :construction: | Local dashboard UI | Single-instance view of local agent activity and task state |
| :dart: | Linear integration | Sync tasks from Linear projects |
| :dart: | Jira integration | Sync tasks from Jira boards |
| :dart: | GitLab adapter | CI pipelines, merge requests, and shipping via GitLab |
| :dart: | Multi-agent coordination | Task claiming, handoff, and conflict resolution across agents |
| :dart: | Token metrics primitives | Local token-savings measurement; Cloud owns team dashboards and per-agent attribution |
| :dart: | AgentRail Cloud | Planned managed team/fleet operations layer: connectors, shared run history/memory, routing/wakes, SSO/RBAC/SCIM, audit, dashboards, support, compliance, and hosted reliability |

## Repository Docs

- [Integration guide for Claude Code / Codex / Cursor](./docs/integration-guide.md)
- [Five-minute quick start](./docs/quick-start.md)
- [Agent recipes for Claude Code, Codex, and Cursor](./docs/agent-recipes.md)
- [Cloud boundary](./docs/cloud.md)
- [MVP completeness scorecard](./docs/mvp-completeness-scorecard.md)
- [OpenAPI contract](./docs/api/task-lifecycle.openapi.yaml)
- [Intake routing architecture](./docs/architecture/intake-routing-engine.md)
- [Intake routing operator OpenAPI](./docs/api/intake-routing-admin.openapi.yaml)
- [Railway production deployment runbook](./docs/deployment/railway-production.md)
- [Live sandbox validation gate](./docs/deployment/live-sandbox-validation.md)
- [Claude Code and Codex lifecycle example](./examples/issue-to-pr-lifecycle.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).

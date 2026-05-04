# AgentRail

AgentRail is an agent-native developer operations API for the full project
lifecycle: issue -> PR -> CI -> review -> ship.

The MVP in this repository is a local, deterministic release candidate that
lets coding agents such as Claude Code, Codex, Cursor, and Devin complete a
task through one compact API instead of stitching together raw GitHub, Linear,
CI, review, and deployment calls.

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

Prerequisite: Node.js 18 or newer.

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
cp .env.example .env
npm start
```

The local API starts on `http://127.0.0.1:3000` by default. It runs without
private credentials and serves the deterministic demo task store.

In a second terminal, run the issue-to-ship demo:

```bash
npm run demo
```

Expected result:

- The agent lists an assigned task.
- It submits a first PR attempt.
- CI and review request a fix.
- It submits a corrected attempt.
- CI passes, review approves, and ship is queued.
- The report includes estimated token savings versus raw GitHub-shaped payloads.

Machine-readable demo output:

```bash
npm run demo:json
```

Run tests:

```bash
npm test
```

Docker:

```bash
docker build -t agentrail .
docker run --rm -p 3000:3000 agentrail
```

## Local API Examples

List the current agent's task:

```bash
curl -s http://127.0.0.1:3000/tasks/mine?status=in_progress
```

Submit work for review:

```bash
curl -s -X POST http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/submit \
  -H 'content-type: application/json' \
  -H 'idempotency-key: submit-local-1' \
  -d '{
    "summary": "Implemented the failing endpoint and opened a pull request.",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" }
    ]
  }'
```

Read CI and review feedback:

```bash
curl -s http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/ci-status
curl -s http://127.0.0.1:3000/tasks/tsk_DEMOISSUETOSHIP01/review-feedback
```

## Architecture

The repository is intentionally API-first:

- `docs/api/task-lifecycle.openapi.yaml` is the public contract.
- `src/app.js` exposes the HTTP routes.
- `src/agent-ship-cycle-demo.js` provides a deterministic lifecycle store for
  local demos and tests.
- `src/task-event-store.js` stores and replays compact lifecycle events.
- `src/task-webhook-store.js` and `src/task-webhook-delivery-worker.js` model
  webhook subscriptions and delivery retries.
- `src/github-actions-ci-adapter.js`, `src/circleci-status-adapter.js`, and
  `src/github-review-feedback-adapter.js` show the adapter pattern for external
  developer tools.
- `sdk/typescript` and `sdk/python` are the generated SDK surfaces agents should
  use instead of hand-rolled HTTP calls.

Technical decision: the public MVP uses deterministic local adapters by
default. Live GitHub/CI integrations are behind adapter interfaces so the OSS
demo is reproducible without secrets, while production deployments can swap in
real providers later.

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

TypeScript local usage:

```ts
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

const tasks = await client.listMyTasks({ status: "in_progress" });
```

Python local usage:

```py
from agentrail import AgentRailClient, TaskStatus

async with AgentRailClient(
    base_url="http://127.0.0.1:3000",
    api_key="ar_local_demo_key",
) as client:
    tasks = await client.list_my_tasks(status=TaskStatus.IN_PROGRESS)
```

Hosted base URLs are still supported by passing a non-local `baseUrl`
explicitly. Local URLs remain the default developer path for this OSS release
candidate.

## Release Scope

This public repo is intentionally limited to the runnable OSS contract: the
local API server, SDKs, demo flow, and operator-facing integration docs.
Internal planning and architecture decision records are kept outside the public
release bundle.

## Repository Docs

- [Integration guide for Claude Code / Codex / Cursor](./docs/integration-guide.md)
- [OpenAPI contract](./docs/api/task-lifecycle.openapi.yaml)
- [End-to-end demo](./docs/demo/agentrail-e2e-demo.md)
- [Release hygiene checklist](./docs/security/release-hygiene.md)
- [Claude Code and Codex lifecycle example](./examples/issue-to-pr-lifecycle.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).

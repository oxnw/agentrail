# AgentRail

[![CI](https://github.com/oxnw/agentrail/actions/workflows/ci.yml/badge.svg)](https://github.com/oxnw/agentrail/actions/workflows/ci.yml)
[![License: Source-Available](https://img.shields.io/badge/License-Source--Available-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org/)

AgentRail is a local-first control plane for coding agents. It gives agents one
compact API for the project loop: issue intake, routing, assigned work, PR
submission, CI, review feedback, and shipping.

The source-available repo is a self-managed single-instance runtime. It is
built for local evaluation and self-hosting. The planned AgentRail Cloud
product is the managed team/fleet layer for hosted connectors, shared run
history, routing, wakes, SSO/RBAC, audit, dashboards, and reliability.

## What Agents Get

- Assigned tasks with compact state and `availableActions`.
- Routing from GitHub or Linear issues to the right local agent.
- Retry-safe mutations through idempotency keys.
- CI and review summaries shaped for action instead of raw log replay.
- Real-time task events over SSE and webhooks.
- Local provider setup for GitHub, CircleCI, and Linear.

## Quickstart

Prerequisites:

- Node.js 24 or newer.
- `npm`.
- Optional provider credentials if you want live GitHub, CircleCI, or Linear
  integration.

Install the CLI:

```bash
npm install -g @agentrail-core/cli
```

Initialize AgentRail:

```bash
agentrail init
```

You can also run the first command without a global install:

```bash
npx @agentrail-core/cli init
```

The interactive setup writes local config under `~/.agentrail`, creates the
local operator bootstrap, and can create your first local agent. It does not ask
you to hand-write API keys or edit a seed task store.

Start the local API:

```bash
agentrail server start
```

In another terminal, verify setup:

```bash
agentrail doctor
```

`doctor` is the success gate. It checks the local API, agent credentials,
profile/routing state, and whether the current agent can see assigned work.

## Connect Providers

Provider connections are optional and can be added after `init`.

```bash
agentrail provider connect github
agentrail provider connect circleci
agentrail provider connect linear
```

Interactive provider setup asks for secrets in hidden prompts and writes them to
local env files. Non-interactive automation can still use environment variables
such as `GITHUB_TOKEN`, `CIRCLECI_TOKEN`, `LINEAR_API_KEY`, and webhook secrets.

Import a Linear issue into AgentRail after connecting Linear:

```bash
agentrail linear import ENG-123
```

Imported provider issues go through the routing engine. If routing is not
configured, AgentRail fails closed instead of silently creating unassigned work.

## Work With Agents

Create or update local agent profiles:

```bash
agentrail agent create
agentrail agent update --agent-id agt_example
```

Inspect local config and connected repos:

```bash
agentrail config show
agentrail repo list
agentrail provider list
```

Repair a task source if older imported data needs to be corrected:

```bash
agentrail task source repair --task-id tsk_... --file source-patch.json
```

## Docker

For a server-only smoke run:

```bash
docker compose up --build
```

The API listens on `http://127.0.0.1:3000` by default. CLI-assisted onboarding
is still the recommended path for a useful local setup because it creates local
agent, routing, and provider state.

## Documentation

- [Developer guide](./docs/developer.md): local development, architecture, API
  contracts, SDK examples, and manual HTTP flows.
- [Five-minute quick start](./docs/quick-start.md): expanded onboarding notes
  and manual reference commands.
- [Integration guide for Claude Code, Codex, and Cursor](./docs/integration-guide.md).
- [Agent recipes](./docs/agent-recipes.md).
- [Cloud boundary](./docs/cloud.md).
- [Task lifecycle OpenAPI](./docs/api/task-lifecycle.openapi.yaml).
- [Intake routing OpenAPI](./docs/api/intake-routing-admin.openapi.yaml).
- [Intake routing architecture](./docs/architecture/intake-routing-engine.md).

## Development

Common repo commands:

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
npm install
npm link
npm run typecheck
npm test
npm run lint:openapi
```

The package exposes the `agentrail` binary:

```bash
agentrail --help
```

## License

AgentRail is source-available software, not open source. See [LICENSE](./LICENSE).

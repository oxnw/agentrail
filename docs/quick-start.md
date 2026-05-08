# AgentRail Five-Minute Quick Start

This is the default local/self-hosted onboarding path for the current OSS
runtime. It is CLI-first: use `agentrail init`, start the local API, create or
connect a local agent, then use `agentrail doctor` as the success gate.

This setup path closes the routing setup work described in
[AGEA-95](/AGEA/issues/AGEA-95) and keeps the integration-doc cleanup from
[AGEA-93](/AGEA/issues/AGEA-93) focused on the current CLI instead of older
manual bootstrap commands.

The examples below use the installed `agentrail` binary.

## Prerequisites

- Node.js 24 or newer.
- `npm`.
- Optional provider credentials for live integrations:
  - `GITHUB_TOKEN` for GitHub.
  - `CIRCLECI_TOKEN` for CircleCI.
  - `LINEAR_API_KEY` for Linear.

## 1. Install The CLI

```bash
npm install -g @agentrail-core/cli
```

If you do not want a global install, you can use `npx @agentrail-core/cli` for
single commands.

## 2. Initialize AgentRail

Run the interactive setup:

```bash
agentrail init
```

Or with `npx`:

```bash
npx @agentrail-core/cli init
```

`agentrail init` writes local setup state under `~/.agentrail`, creates a local
operator bootstrap for this machine, and can create the first agent profile and
agent env file. Accept the prompt to create the first agent if you want the
shortest path to a passing doctor check.

If you are running in a non-interactive shell, provide explicit defaults:

```bash
agentrail init --mode server --repo /path/to/target-repo --yes
```

Non-interactive setup writes config and operator state. You can create the
agent in step 4.

## 3. Start The Local API

Keep this running in one terminal:

```bash
agentrail server start
```

Expected output includes:

```text
AgentRail API listening on http://127.0.0.1:3000
```

## 4. Create Or Update The First Agent

If `agentrail init` already created your first agent, skip to doctor.

Otherwise, in a second terminal:

```bash
agentrail agent create
```

The agent wizard creates scoped local agent credentials, writes the managed
agent env file, creates or updates the agent profile, and can configure starter
routing for the selected repo.

Use this later to change permissions, routing, or repo allowlists:

```bash
agentrail agent update --agent-id agt_example
```

## 5. Run Doctor

```bash
agentrail doctor
```

Success means:

- The local API is reachable.
- The current agent env file is usable.
- The agent profile is active.
- Routing state exists for the current repo.
- `/tasks/mine?status=in_progress&limit=1` returns assigned work when setup
  verification work is present.

If doctor fails, fix the reported missing piece before starting a coding agent.
Do not treat setup as complete until doctor passes.

## 6. Connect Providers

Provider connections are optional. Add them when you want live issue intake, CI,
review, or outbound mutation behavior.

```bash
agentrail provider connect github
agentrail provider connect circleci
agentrail provider connect linear
```

Provider setup stores secrets locally and masks prompt input. Environment
variables are still supported for CI/non-interactive automation.

After connecting Linear, import an issue:

```bash
agentrail linear import ENG-123
```

Imported Linear and GitHub provider tasks go through the routing engine. Missing
routing configuration fails closed instead of creating hidden unassigned work.

## 7. Start A Coding Agent

Load the generated agent env file before launching a runner from the target
repo. The exact file path depends on the agent id created by the wizard.

Example:

```bash
source ~/.agentrail/agent.env
cd /path/to/target-repo
codex
```

The shared runner guidance lives in [agent recipes](./agent-recipes.md).

## Advanced Manual Lifecycle Calls

Manual HTTP and API-key examples are developer reference material, not the
recommended onboarding path. See [developer guide](./developer.md#manual-http-reference)
for raw `curl` calls, SDK snippets, and lower-level API details.

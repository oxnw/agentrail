# Local And Self-Hosted Setup CLI Contract

Status: proposed setup contract pending approval

Owner: CTO

Related issues: [AGEA-116](/AGEA/issues/AGEA-116), [AGEA-95](/AGEA/issues/AGEA-95), [AGEA-93](/AGEA/issues/AGEA-93)

Related contracts:

- [task lifecycle OpenAPI](../api/task-lifecycle.openapi.yaml)
- [operator routing OpenAPI](../api/intake-routing-admin.openapi.yaml)
- [agent recipes](../agent-recipes.md)

Current implementation status:

- `agentrail init` is shipped.
- `agentrail doctor` is shipped and is the readiness gate.
- `agentrail server start` and `agentrail agent create/connect` remain planned
  wrappers over the HTTP contracts below.

## Decision

AgentRail setup is a two-phase flow:

1. Pre-server project init writes local configuration, selected runtime mode,
   base URL, provider placeholders, persistence settings, and secret-handling
   guardrails.
2. Server-backed agent registration creates or updates one usable
   `AgentIdentity`, one scoped AgentRail API key, one `AgentProfile`, and either
   a starter routing rule or a deterministic demo task. It then writes the local
   agent env/config output needed for Codex, Claude Code, or Cursor to call
   `/tasks/mine`.

The product path is a CLI helper. Normal users must not hand-create agent
identity, profile, key, and starter routing state through raw `curl`.

The default CLI experience is interactive when run in a TTY. It should infer
safe defaults, show them as a reviewable setup plan, ask concise questions for
only the missing decisions, then write files or call server APIs after the user
confirms. Every interactive path has an equivalent flag-based path for scripts,
CI, docs, and coding agents.

The current repository still exposes the manual quick-start path. The CLI names
below define the planned product contract and the order implementation should
follow.

## Brainstorming Outcome

Chosen approach: guided interactive CLI plus structured local setup state as
the source of truth, with optional Markdown/Obsidian export. The CLI should
write local JSON and environment files that mirror the cloud setup/service
data model closely enough to migrate later. Human-readable Markdown can be
generated from that state, but editing Markdown must not be the canonical write
path.

Rejected: flags-only setup as the primary UX. It is deterministic and good for
automation, but it makes first-time users learn too much of AgentRail's
identity, profile, routing, and provider model before they see an agent retrieve
work.

Rejected: Markdown or Obsidian as the local source of truth. It is attractive
for local-first inspection, but it creates a second persistence architecture for
schema evolution, concurrency, API querying, secret separation, and cloud
migration.

Rejected: config-only setup with no structured local persistence. It is the
smallest implementation, but it leaves the first real LLM-agent identity,
profile, routing state, and task visibility path ambiguous.

## Setup UX Defaults

The default setup should ask only for values needed to make the first task
assignment work:

- Base URL defaults to `http://127.0.0.1:3000`; host defaults to `127.0.0.1`;
  port defaults to `3000`.
- Local persistence defaults to a structured file-backed store under
  `.agentrail/` for self-hosted use. Disposable demos can opt into memory.
- When run inside a git checkout, target repo defaults to the current repo.
- Repo allowlist defaults to the current remote slug when the CLI can infer it;
  otherwise the current repo path is allowed for local-only demo mode.
- Default branch comes from the remote default branch when available, then the
  current branch, then `main`.
- The first LLM-agent identity is derived from `--runner` and `--name`, with a
  stable generated `agentId` such as `agt_codex_local` unless explicitly set.
- Starter routing is minimal: one profile, one repo-scoped rule, and one setup
  verification task or demo task so `/tasks/mine` proves visibility.
- Provider secrets are never requested during the initial repo/base-URL setup
  questions. After files are written, `init` may optionally offer GitHub
  connection with masked token entry, and dedicated provider commands can
  prompt for masked secrets interactively or read env vars non-interactively.

## Interactive Setup UX

`agentrail init` without flags starts an interactive wizard when stdin is a TTY:

```text
AgentRail local setup

Detected:
- Target repo: oxnw/agentrail
- Default branch: main
- Local API: http://127.0.0.1:3000
- Runner candidates: codex, claude-code, cursor

? Setup mode
  Demo, no provider tokens
  Self-hosted with real GitHub/CI providers

? First agent runner
  Codex
  Claude Code
  Cursor
  Custom

? Agent display name
  Codex Local

? Repo allowlist
  oxnw/agentrail

? Enable Markdown/Obsidian export?
  No, keep structured local store only
  Yes, write read-only Markdown snapshots

Review setup plan:
- Write .agentrail/config.json
- Start local API on 127.0.0.1:3000
- After server start, create AgentIdentity agt_codex_local
- Create AgentProfile for oxnw/agentrail
- Create starter routing and setup verification task
- Write .agentrail/agent.env with mode 0600
- Run agentrail doctor and require /tasks/mine to return assigned work

? Continue
  Yes
  No, print commands only
```

Wizard rules:

- Use a terminal-safe prompt library or small internal prompt layer; do not make
  the CLI depend on a browser UI.
- Every question must show the inferred default first.
- Optional provider secrets are entered through masked terminal prompts when
  the user chooses an interactive provider connect step.
- `No, print commands only` emits the equivalent non-interactive command set so
  users can inspect or paste it later.
- Non-TTY mode never blocks on prompts. It requires explicit flags or exits with
  a compact list of missing flags and suggested defaults.
- `--yes` accepts inferred defaults only when the mode is safe: local bind,
  no provider secrets requested, and generated secret files ignored by git.
- `agentrail agent create --interactive` runs only the server-backed
  registration half for users who already created `.agentrail/config.json`.

## Command Order

### Phase 1: Project Init

Run this before the AgentRail server is started:

```bash
agentrail init
```

Non-interactive equivalent:

```bash
agentrail init \
  --mode server \
  --base-url http://127.0.0.1:3000 \
  --port 3000 \
  --provider-mode disabled \
  --persistence file \
  --repo /path/to/target-repo
```

`--provider-mode` is a convenience flag that sets provider config from one
choice: `providers.github.mode` receives the selected mode, and
`providers.circleci.mode` is `real` only when the selected mode is `real`;
otherwise it is `disabled`.

`agentrail init` writes local files without requiring the server to be
reachable. After that write step, the interactive flow may optionally create
`provider.env` if the user chooses immediate GitHub connection.

Expected local files:

```text
.agentrail/config.json
.agentrail/agent.env.example
.agentrail/README.md
```

`.agentrail/config.json` shape:

```json
{
  "version": 1,
  "setup": {
    "interactionMode": "interactive",
    "acceptedDefaults": true
  },
  "mode": "demo",
  "server": {
    "host": "127.0.0.1",
    "port": 3000,
    "baseUrl": "http://127.0.0.1:3000"
  },
  "persistence": {
    "kind": "file",
    "engine": "sqlite",
    "eventStorePath": ".agentrail/events.ndjson",
    "statePath": ".agentrail/state.sqlite"
  },
  "exports": {
    "markdown": {
      "enabled": false,
      "path": ".agentrail/notes"
    }
  },
  "providers": {
    "github": {
      "mode": "demo",
      "tokenEnv": "GITHUB_TOKEN"
    },
    "circleci": {
      "mode": "disabled",
      "tokenEnv": "CIRCLECI_TOKEN"
    }
  },
  "targetRepo": {
    "path": "/path/to/target-repo",
    "allowlist": ["oxnw/agentrail"],
    "defaultBranch": "main"
  }
}
```

### Start Server

For the current repo, the manual equivalent remains:

```bash
npm start
```

The planned CLI wrapper is:

```bash
agentrail server start
```

`agentrail server start` reads `.agentrail/config.json`, binds the local server
to `127.0.0.1` by default, and exits non-zero when real provider mode is
configured but required provider token env vars are absent. The CLI prints a
specific error such as `Missing required provider token: GITHUB_TOKEN` instead
of silently falling back.

### Phase 2: Agent Registration

Run this after the server is reachable:

```bash
agentrail agent create \
  --runner codex \
  --agent-id agt_codex_local \
  --name "Codex Local" \
  --repo-allowlist oxnw/agentrail \
  --capability-tags code,tests,api \
  --instructions-path AGENTS.md \
  --provider github:octocat \
  --starter demo-task
```

For an existing self-hosted agent identity:

```bash
agentrail agent connect \
  --runner claude-code \
  --agent-id agt_claude_local \
  --instructions-path AGENTS.md
```

The one-command shortcut composes the same two phases and starts the server
between them:

```bash
agentrail init --interactive --start
```

Non-interactive equivalent:

```bash
agentrail init --mode demo --start --yes \
  --runner codex \
  --agent-id agt_codex_local \
  --name "Codex Local" \
  --repo /path/to/target-repo \
  --repo-allowlist oxnw/agentrail \
  --capability-tags code,tests,api \
  --instructions-path AGENTS.md
```

## Persistence And Markdown Export

The local/self-hosted data model should stay cloud-shaped:

- `AgentIdentity`, API key metadata, `AgentProfile`, routing rule revisions,
  task assignments, lifecycle state, and event cursors live in a structured
  local store.
- The first implementation may use SQLite or an equivalent structured local
  store. The important boundary is that the store is queryable, versioned, and
  compatible with API semantics; ad hoc Markdown parsing is not acceptable.
- `.agentrail/config.json` stores non-secret configuration only.
- `.agentrail/agent.env` stores generated local agent secrets and must be
  created with mode `0600`.
- Optional Markdown export writes snapshots such as
  `.agentrail/notes/tasks/<task-id>.md`,
  `.agentrail/notes/routing/<decision-id>.md`, and
  `.agentrail/notes/setup.md`.
- Markdown export is one-way unless a future ADR explicitly designs safe import.
  Users may read or index it in Obsidian, but AgentRail must not rely on it for
  correctness.

## Required Inputs

`agentrail init` requires or derives:

- `server.baseUrl`, `host`, and `port`; default is
  `http://127.0.0.1:3000`.
- `mode`: `demo` or `server`.
- `providerMode`: `demo`, `real`, or `disabled`; `--provider-mode` maps this
  into `providers.github.mode` and `providers.circleci.mode`.
- Persistence choice: `memory` for disposable demos or `file` for local
  self-hosted runs. Future hosted/self-hosted packages may add `postgres`.
- Provider config placeholders: env var names such as `GITHUB_TOKEN`,
  `CIRCLECI_TOKEN`, and `CIRCLECI_WEBHOOK_SECRET`, not secret values.
- Target repository path.
- Interaction mode: `interactive` when a TTY is available, `non_interactive`
  when all required flags are present, or `print_only` when the user wants the
  equivalent commands without writing files.

`agentrail agent create` requires:

- Runner type: `codex`, `claude-code`, `cursor`, `devin`, or `custom`.
- LLM-agent display name and stable `agentId`.
- Repo allowlist. Real provider mode must reject an empty allowlist.
- Capability tags and optional ownership tags.
- Instructions path, usually `AGENTS.md` or `docs/agent-recipes.md`.
- Provider identity mappings such as `github:octocat`.
- Safety policy defaults. The default is local-only bind, least-privilege
  scopes, no provider write access unless submit/ship is enabled, and generated
  secret files with mode `0600`.

## Server-Backed Registration Contract

The CLI wraps existing OpenAPI-backed operations and sends idempotency keys for
every mutation.

### 1. Create Or Update Agent API Key

Contract source: `POST /agent-api-keys` in
[task lifecycle OpenAPI](../api/task-lifecycle.openapi.yaml).

Request body generated by `agentrail agent create`:

```json
{
  "agent": {
    "id": "agt_codex_local",
    "displayName": "Codex Local",
    "role": "coding_agent",
    "externalIdentities": [
      { "provider": "github", "subject": "octocat" }
    ]
  },
  "scopes": [
    "tasks:read",
    "tasks:write",
    "ci:read",
    "reviews:read",
    "events:read"
  ],
  "rateLimit": {
    "windowSeconds": 60,
    "maxRequests": 600
  },
  "expiresAt": null
}
```

Expected response fields used by the CLI:

```json
{
  "data": {
    "id": "akey_01JY52RRF5PAGHT5DCZXJ4N2DG",
    "apiKey": "ar_live_example_created_once",
    "agent": {
      "id": "agt_codex_local",
      "displayName": "Codex Local",
      "role": "coding_agent",
      "externalIdentities": [
        { "provider": "github", "subject": "octocat" }
      ]
    },
    "scopes": ["tasks:read", "tasks:write", "ci:read", "reviews:read", "events:read"],
    "status": "active"
  }
}
```

The CLI stores only `data.apiKey` in `.agentrail/agent.env`, never in
`.agentrail/config.json`. The key ID is not sufficient for authentication and
must not be printed as if it were a secret.

### 2. Create Or Replace AgentProfile

Contract source: `PUT /operator/routing/agent-profiles/{agentId}` in
[operator routing OpenAPI](../api/intake-routing-admin.openapi.yaml).

Request body generated by `agentrail agent create`:

```json
{
  "displayName": "Codex Local",
  "role": "coding_agent",
  "status": "active",
  "capabilityTags": ["code", "tests", "api"],
  "ownershipTags": [],
  "repoAllowlist": ["oxnw/agentrail"],
  "maxConcurrentTasks": 1,
  "sourceRef": "agentrail-cli:init",
  "changeReason": "Seed local Codex agent profile during self-hosted setup."
}
```

The resulting `AgentProfile.agentId` must match the `AgentIdentity.id` on the
API key. A profile with `status: "paused"` or a repo-disallowed task must not be
eligible for routing.

### 3. Create Starter Routing State

In `demo` mode, registration verifies that the deterministic task can be read:

```bash
GET /tasks/mine?status=in_progress&limit=1
```

In `server` mode, registration creates or updates a starter routing rule through
`PUT /operator/routing/rule-sets/current` or asks the operator to choose an
existing rule set. The minimum starter rule targets the new `agentId` only for
the repo allowlist and capability tags provided during setup. The CLI must then
create or ingest one setup verification task through the normal assignment path.
Real provider mode may use a selected provider issue instead, but it must still
end with an assigned AgentRail task visible to the new agent.

The CLI must run `agentrail doctor` after registration. Success means the
generated key can call `/tasks/mine` against the configured base URL.

## Smoke Tests And Success Gate

`agentrail doctor` is part of setup, not an optional diagnostic. Setup reports
success only after these checks pass:

1. `GET /health` returns `status: "ok"` from the configured base URL.
2. In auth-enabled mode, the generated `AGENTRAIL_API_KEY` authenticates as the
   expected `AgentIdentity.id`.
3. The generated or selected `AgentProfile` is active and repo-eligible.
4. Starter routing has either assigned the setup verification task to the agent
   or demo mode exposes the deterministic demo task.
5. The selected runner environment can retrieve work:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Expected minimum response shape:

```json
{
  "data": [
    {
      "id": "tsk_setup_smoke_agt_codex_local",
      "identifier": "LOCAL-SETUP-1",
      "assigneeAgentId": "agt_codex_local",
      "availableActions": ["submit"]
    }
  ],
  "availableActions": ["submit"]
}
```

If `data` is empty, setup is not complete. The CLI should print the failed
contract object, the missing route/profile/task source, and the next repair
command instead of telling the user to start the LLM agent.

## Agent Env Output

`agentrail agent create` writes `.agentrail/agent.env` with mode `0600`:

```bash
AGENTRAIL_BASE_URL=http://127.0.0.1:3000
AGENTRAIL_API_KEY=ar_live_example_created_once
AGENTRAIL_AGENT_ID=agt_codex_local
AGENTRAIL_AGENT_RUNNER=codex
AGENTRAIL_REPO_ALLOWLIST=oxnw/agentrail
AGENTRAIL_AGENT_RECIPE_PATH=/path/to/agentrail/docs/agent-recipes.md
```

It also prints the next command for the selected runner.

Codex:

```bash
source .agentrail/agent.env && cd /path/to/target-repo && codex
```

Claude Code:

```bash
source .agentrail/agent.env && cd /path/to/target-repo && claude --append-system-prompt-file "$AGENTRAIL_AGENT_RECIPE_PATH"
```

Cursor:

```bash
source .agentrail/agent.env && cursor /path/to/target-repo
```

For Cursor, the CLI should also write or update a project rule that contains
the shared AgentRail contract from [agent recipes](../agent-recipes.md).

## Migration Path

The first implementation plan should preserve the current self-hosted
quick-start while adding the setup path incrementally:

1. Keep `npm start`, Docker Compose, and the explicit task-store/task-source
   setup examples working for existing users.
2. Add the interactive CLI wizard as a wrapper over existing and planned
   OpenAPI operations, leaving raw HTTP examples as reference material rather
   than the primary UX.
3. Add structured local persistence behind the same store interfaces used by
   server mode so local/self-hosted state can later move to Postgres without a
   product fork.
4. Add optional Markdown export only after the structured store emits stable
   setup, task, and routing snapshots.
5. Update [AGEA-93](/AGEA/issues/AGEA-93) integration docs to make the CLI path
   the default and keep the manual curl path as an advanced appendix.

## Tradeoffs

Chosen: CLI helper over docs-only setup. Docs are necessary, but a normal user
should not have to understand four setup objects before their first
agent can call `/tasks/mine`.

Chosen: CLI wraps existing OpenAPI operations instead of inventing a hidden
setup database path. This keeps AgentIdentity, API key, AgentProfile, routing,
and task visibility testable through public contracts.

Rejected: docs-only setup. It is fast to publish but fails the onboarding goal
because identity, key, profile, and routing state remain easy to mis-create.

Rejected: asking users to run raw `curl` for identity/profile/key creation. It
is technically complete but too error-prone, leaks secrets into shell history,
and makes retry/idempotency behavior inconsistent.

Rejected for the initial CLI: a monolithic server endpoint that hides all setup
objects. It could be convenient later, but it would add another privileged API
surface before the underlying auth and routing contracts are stable.

## Compatibility And Failure Handling

- `agentrail init` is safe to rerun and should preserve existing generated
  secrets unless `--rotate-key` is explicit.
- Interactive setup must be resumable. If `.agentrail/config.json` exists, the
  wizard shows the current values and asks whether to keep, edit, or print the
  equivalent command.
- All server mutations use deterministic payload-derived idempotency keys so
  exact replays are safe and later edits do not collide with earlier requests.
- `agentrail agent create --rotate-key` rotates the API key and rewrites
  `.agentrail/agent.env`.
- Real provider mode fails closed when required provider token env vars are
  missing.
- The CLI never commits `.agentrail/agent.env`, provider tokens, or generated
  AgentRail API keys.
- The first auth-enabled local setup run may create an admin key through the
  documented auth creation path. Later setup calls require the admin key or a
  delegated setup-capable operator key.

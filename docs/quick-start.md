# AgentRail Five-Minute Quick Start

This is the default local/self-hosted onboarding path for the current OSS
runtime.

It uses the shipped CLI pieces that exist today:

- `agentrail init` to write `.agentrail` scaffolding.
- Public auth/routing/setup endpoints to create the first agent identity,
  profile, rule set, and setup check task.
- `agentrail doctor` as the success gate.

This closes the routing setup work described in
[AGEA-95](/AGEA/issues/AGEA-95) and makes the setup story clearer per
[AGEA-93](/AGEA/issues/AGEA-93). It is still local/self-managed OSS, not the
planned AgentRail Cloud team setup service.

The examples below use `./agentrail ...` so they work directly from this
repository checkout after `npm install`. That is the same CLI surface exposed
as `agentrail` when the package is installed as a binary.

## Prerequisites

- Node.js 22.6 or newer.
- A terminal with `git`, `npm`, and `curl`.
- A GitHub token that can read and open pull requests in the repository you use
  for the sample task source.

## 1. Initialize Local Setup Files

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
npm install
./agentrail init --mode server --provider-mode disabled --repo "$PWD"
cp .env.example .env
cp examples/self-hosted-task-store.json .agentrail.tasks.json
```

`agentrail init` writes `.agentrail/config.json`,
`.agentrail/agent.env.example`, and `.agentrail/README.md`, but it does not
create agent credentials or claim setup is finished.

## 2. Start The Local API

Edit the copied task-store JSON so the owner, repo, issue number, working
branch, and assignee match your environment. Then start the server:

```bash
export GITHUB_TOKEN=ghp_your_token
export AGENTRAIL_TASK_STORE_PATH=$PWD/.agentrail.tasks.json
npm start
```

Expected output:

```text
AgentRail API listening on http://127.0.0.1:3000
```

Leave this terminal running.

## 3. Create Operator And Agent Keys

Before running the commands below, keep these two keys separate:

- `AGENTRAIL_OPERATOR_KEY`: an admin key for setup tasks. It is used to create
  agent keys, write routing profiles, update routing rules, and create the
  setup verification task. Humans and setup scripts use this key.
- `AGENTRAIL_API_KEY`: the runtime key for one agent. It is used by that agent
  to call endpoints like `/tasks/mine`, submit work, read CI status, and read
  review feedback. The agent process uses this key.

You create the operator key first because AgentRail needs one admin-capable key
before it can create and configure the first working agent.

In a second terminal, create the first operator key:

```bash
curl -s -X POST http://127.0.0.1:3000/agent-api-keys \
  -H "content-type: application/json" \
  -H "idempotency-key: create-local-setup-admin" \
  -d '{
    "agent": {
      "id": "agt_setup_operator",
      "displayName": "Local Setup Operator",
      "role": "operator"
    },
    "scopes": [
      "auth:admin",
      "routing:admin",
      "routing:read",
      "tasks:read"
    ]
  }'
```

Copy the returned `data.apiKey` value into your shell:

```bash
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_OPERATOR_KEY=<paste-the-operator-data.apiKey-here>
export AGENTRAIL_AGENT_ID=agt_codex_local
```

What you just did:

- created the first admin-capable key for this local AgentRail server
- stored it in `AGENTRAIL_OPERATOR_KEY` so the next setup calls can authenticate
- chose `agt_codex_local` as the id for the first coding agent

Keep `AGENTRAIL_OPERATOR_KEY` private. It can change routing and create other
keys.

Create the scoped agent key that the coding agent will use:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/agent-api-keys" \
  -H "authorization: Bearer $AGENTRAIL_OPERATOR_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: create-agent-key:$AGENTRAIL_AGENT_ID:v1" \
  -d '{
    "agent": {
      "id": "agt_codex_local",
      "displayName": "Codex Local",
      "role": "coding_agent"
    },
    "scopes": [
      "tasks:read",
      "tasks:write",
      "ci:read",
      "reviews:read",
      "events:read",
      "ship:write"
    ]
  }'
```

Copy that second `data.apiKey` value too:

```bash
export AGENTRAIL_API_KEY=<paste-the-agent-data.apiKey-here>
```

What you just did:

- created the runtime key for the first coding agent
- limited that key to agent work scopes such as reading tasks and submitting work
- stored it in `AGENTRAIL_API_KEY` so the agent process can use it later

Keep `AGENTRAIL_API_KEY` private too, but note the difference: this key should
be used by the agent runtime, not by a human changing setup state.

## 4. Create Profile, Routing, And Setup Check State

Create the first `AgentProfile`:

```bash
curl -s -X PUT "$AGENTRAIL_BASE_URL/operator/routing/agent-profiles/$AGENTRAIL_AGENT_ID" \
  -H "authorization: Bearer $AGENTRAIL_OPERATOR_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: profile:$AGENTRAIL_AGENT_ID:v1" \
  -d '{
    "displayName": "Codex Local",
    "role": "coding_agent",
    "status": "active",
    "capabilityTags": ["code", "tests", "api"],
    "ownershipTags": [],
    "repoAllowlist": ["oxnw/agentrail"],
    "maxConcurrentTasks": 1,
    "sourceRef": "quick-start",
    "changeReason": "Create the first local setup profile."
  }'
```

Create the first routing rule set:

```bash
curl -s -X PUT "$AGENTRAIL_BASE_URL/operator/routing/rule-sets/current" \
  -H "authorization: Bearer $AGENTRAIL_OPERATOR_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: rule-set:$AGENTRAIL_AGENT_ID:v1" \
  -d '{
    "sourceRef": "quick-start",
    "changeReason": "Create the first local routing rule.",
    "rules": [
      {
        "id": "quick-start-first-agent",
        "name": "Route the setup repo to the first local agent",
        "enabled": true,
        "priority": 100,
        "conditions": {
          "repositories": ["oxnw/agentrail"]
        },
        "target": {
          "type": "agent",
          "id": "agt_codex_local"
        },
        "confidence": 1,
        "explanation": "The first local repo routes directly to the setup agent."
      }
    ],
    "classifier": {
      "enabled": false,
      "provider": "internal-router",
      "confidenceThreshold": 0.8,
      "maxCandidates": 3,
      "fallbackTriageQueueId": "triage_default"
    }
  }'
```

Create the setup verification task:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/operator/setup/verification-task" \
  -H "authorization: Bearer $AGENTRAIL_OPERATOR_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: setup-verification:$AGENTRAIL_AGENT_ID:v1" \
  -d '{
    "agentId": "agt_codex_local",
    "sourceRef": "quick-start"
  }'
```

## 5. Fill `.agentrail/agent.env`

`agentrail agent create` now automates this path. For the manual OSS flow,
fill the generated env file once if you are not using the CLI:

When you use `agentrail agent create`, AgentRail generates the key for you and
asks what the agent should be allowed to do. The normal CLI path offers
permission presets first, with an advanced mode for custom scopes.

```bash
touch .agentrail/agent.env
chmod 600 .agentrail/agent.env
cat > .agentrail/agent.env <<'EOF'
AGENTRAIL_BASE_URL=http://127.0.0.1:3000
AGENTRAIL_API_KEY=<paste-the-agent-data.apiKey-here>
AGENTRAIL_AGENT_ID=agt_codex_local
AGENTRAIL_AGENT_RUNNER=codex
AGENTRAIL_REPO_ALLOWLIST=oxnw/agentrail
AGENTRAIL_AGENT_RECIPE_PATH=/path/to/agentrail/docs/agent-recipes.md
EOF
```

This file is what the coding agent will actually load at runtime:

- `AGENTRAIL_API_KEY` tells the agent who it is when it talks to AgentRail
- `AGENTRAIL_AGENT_ID` must match the id used when you created the agent key
- `AGENTRAIL_REPO_ALLOWLIST` tells the agent which repo this local setup is for
- `AGENTRAIL_AGENT_RECIPE_PATH` points at the shared operating instructions for
  the agent runner

## 6. Run `agentrail doctor`

```bash
AGENTRAIL_OPERATOR_KEY="$AGENTRAIL_OPERATOR_KEY" \
./agentrail doctor
```

Success means:

- `GET /health` returned `status: "ok"`.
- `AGENTRAIL_API_KEY` authenticated against `GET /tasks/mine`.
- The `AgentProfile` is active for the repo allowlist.
- The current rule set targets the agent.
- `GET /tasks/mine?status=in_progress&limit=1` returned the setup task, for
  example `LOCAL-SETUP-AGT-CODEX-LOCAL`.

If doctor fails because no assigned work is visible, rerun the setup check task
endpoint from step 4 and fix the missing profile/rule/task state before you
start the coding agent.

## 7. Advanced Manual Lifecycle Calls

The remaining raw lifecycle curls are reference material after doctor passes.

List assigned work:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Submit an attempt. AgentRail creates or reuses the GitHub pull request from the
configured task source.

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_SELFHOSTED000000000001/submit" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: submit-quick-start-1" \
  -d '{
    "summary": "Implemented the endpoint and opened a pull request.",
    "mode": "adapter_managed",
    "pullRequest": {
      "title": "Validate the self-hosted AgentRail loop",
      "draft": false
    }
  }'
```

Read CI and review:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_SELFHOSTED000000000001/ci-status" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"

curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_SELFHOSTED000000000001/review-feedback" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Ship after CI and review are green:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_SELFHOSTED000000000001/ship" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: ship-quick-start-1" \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "replace-with-the-current-task-head-sha"
  }'
```

Use the task's current `headSha` from `GET /tasks/mine` or the GitHub pull
request head commit for `expectedHeadSha`.

## 8. Give The Flow To A Coding Agent

Open the repository where the agent should edit code. Then start the agent with
the AgentRail environment variables and the operating recipe:

```bash
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=<paste-the-agent-data.apiKey-here>
```

Claude Code:

```bash
claude --append-system-prompt-file /path/to/agentrail/docs/agent-recipes.md
```

Other agents:

- Add [agent recipes](./agent-recipes.md) to the agent's project instructions.
- Tell the agent to start with
  `GET /tasks/mine?status=in_progress&limit=1`.

## Auth Note

The default server now wires agent auth. Use a real `data.apiKey` secret from
`POST /agent-api-keys`; placeholder demo keys are no longer valid on the core
runtime path.

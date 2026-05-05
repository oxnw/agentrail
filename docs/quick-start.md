# AgentRail Five-Minute Quick Start

This path proves the local AgentRail lifecycle contract with the core
self-hosted server path instead of the removed demo runtime.

It is a local/self-managed OSS path, not the planned AgentRail Cloud team
control plane. Cloud differentiation lives in managed connectors, durable shared
run history and memory, routing and wakes, SSO/RBAC/SCIM, audit, dashboards,
support, compliance, and hosted reliability.

Current setup is manual: copy the example task-store and task-source files,
export the local base URL, and bootstrap a real AgentRail API key. The planned
`agentrail init` and `agentrail agent create/connect` flow is specified in the
[local and self-hosted setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md).

## Prerequisites

- Node.js 22.6 or newer.
- A terminal with `git`, `npm`, and `curl`.
- A GitHub token that can read and open pull requests in the repository you use
  for the sample task source.

## 1. Start the Local API

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
npm install
cp .env.example .env
cp examples/self-hosted-task-store.json .agentrail.tasks.json
cp examples/self-hosted-task-sources.json .agentrail.task-sources.json
```

Edit both copied files so the owner, repo, issue number, working branch, and
assignee match your environment. Then start the server:

```bash
export GITHUB_TOKEN=ghp_your_token
export AGENTRAIL_TASK_STORE_PATH=$PWD/.agentrail.tasks.json
export AGENTRAIL_TASK_SOURCES="$(cat .agentrail.task-sources.json)"
npm start
```

Expected output:

```text
AgentRail API listening on http://127.0.0.1:3000
```

Leave this terminal running.

## 2. Check Health

In a second terminal:

```bash
curl -s http://127.0.0.1:3000/health
```

Expected shape:

```json
{
  "status": "ok",
  "service": "agentrail-service",
  "publicBaseUrl": "http://127.0.0.1:3000",
  "pathPrefix": null
}
```

The response also includes time and uptime fields.

## 3. Bootstrap an API Key

```bash
curl -s -X POST http://127.0.0.1:3000/agent-api-keys \
  -H "content-type: application/json" \
  -H "idempotency-key: bootstrap-local-admin" \
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

Save the returned `data.apiKey` value in your shell:

```bash
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=<paste-the-returned-data.apiKey-here>
```

## 4. Make the Same Calls by Hand

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

## 5. Give the Flow to a Coding Agent

Open the repository where the agent should edit code. Then start the agent with
the AgentRail environment variables and the operating recipe:

```bash
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=<paste-the-returned-data.apiKey-here>
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

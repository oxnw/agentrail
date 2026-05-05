# AgentRail Five-Minute Quick Start

This path proves the local AgentRail lifecycle contract without GitHub tokens,
CI tokens, or a hosted account.

It is a local/self-managed OSS path, not the planned AgentRail Cloud team
control plane. Cloud differentiation lives in managed connectors, durable shared
run history and memory, routing and wakes, SSO/RBAC/SCIM, audit, dashboards,
support, compliance, and hosted reliability.

Current setup is manual: start the demo server, export the local base URL, and
use `ar_local_demo_key` as a placeholder. The planned `agentrail init` and
`agentrail agent create/connect` flow is specified in the
[local and self-hosted setup CLI contract](./architecture/local-self-hosted-setup-cli-contract.md).

## Prerequisites

- Node.js 22.6 or newer.
- A terminal with `git`, `npm`, and `curl`.

## 1. Start the Local API

```bash
git clone https://github.com/oxnw/agentrail.git
cd agentrail
npm install
cp .env.example .env
npm run demo:server
```

Expected output:

```text
AgentRail demo API listening on http://127.0.0.1:3000
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

## 3. Run the Lifecycle Demo

```bash
npm run demo
```

The demo uses task `tsk_DEMOISSUETOSHIP01` and walks through:

- list assigned task,
- submit first attempt,
- receive failed CI and requested changes,
- submit corrected attempt,
- read green CI and approved review,
- queue ship,
- report estimated token savings.

For machine-readable output:

```bash
npm run demo:json
```

## 4. Make the Same Calls by Hand

```bash
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=ar_local_demo_key
```

List assigned work:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/mine?status=in_progress&limit=1" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Submit an attempt:

The pull request URL below is a deterministic demo placeholder. Real
automation should prefer adapter-managed submit, where AgentRail creates or
reuses the provider PR and returns the PR URL through lifecycle state.

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/submit" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: submit-quick-start-1" \
  -d '{
    "summary": "Implemented the endpoint and opened a pull request.",
    "mode": "artifact",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" }
    ]
  }'
```

Read CI and review:

```bash
curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/ci-status" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"

curl -s "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/review-feedback" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY"
```

Submit the corrected attempt:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/submit" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: submit-quick-start-2" \
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

Ship after CI and review are green:

```bash
curl -s -X POST "$AGENTRAIL_BASE_URL/tasks/tsk_DEMOISSUETOSHIP01/ship" \
  -H "authorization: Bearer $AGENTRAIL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: ship-quick-start-1" \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
  }'
```

## 5. Give the Flow to a Coding Agent

Open the repository where the agent should edit code. Then start the agent with
the AgentRail environment variables and the operating recipe:

```bash
cd /path/to/target-repo
export AGENTRAIL_BASE_URL=http://127.0.0.1:3000
export AGENTRAIL_API_KEY=ar_local_demo_key
```

Claude Code:

```bash
claude --append-system-prompt-file /path/to/agentrail/docs/agent-recipes.md
```

Other agents:

- Add [agent recipes](./agent-recipes.md) to the agent's project instructions.
- Tell the agent to start with
  `GET /tasks/mine?status=in_progress&limit=1`.

## Local Auth Note

Do not create an API key for the quick-start demo server. `AGENTRAIL_MODE=demo`
does not wire the auth store, so `ar_local_demo_key` is only a local SDK
placeholder. API key creation is for auth-enabled deployments; see
[integration guide](./integration-guide.md#auth-enabled-operation).

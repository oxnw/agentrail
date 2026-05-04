# AgentRail Quick Start

Run the local AgentRail API and complete the deterministic issue-to-ship task in under five minutes.

## Prerequisites

- Docker Desktop with Docker Compose, or Node.js 22.6 or newer.
- `curl` for the HTTP walkthrough.

## One-Command Local Setup

From a fresh shell:

```bash
git clone https://github.com/oxnw/agentrail.git && cd agentrail && docker compose up --build
```

The API listens on `http://127.0.0.1:3000`. Docker Compose stores task event stream replay data in the `agentrail-event-data` volume at `/data/task-events.ndjson`. Keep this terminal running and use a second terminal for the lifecycle calls below.

If you already cloned the repo, run only:

```bash
docker compose up --build
```

Health check:

```bash
curl -s http://127.0.0.1:3000/health
```

Expected response:

```json
{"status":"ok"}
```

## Node Local Setup

Use this path when you are actively editing the service:

```bash
cp .env.example .env
npm start
```

To persist SSE and webhook replay events across local restarts, set this in `.env` before starting:

```bash
AGENTRAIL_EVENT_STORE_PATH=.agentrail/task-events.ndjson
```

## First Task Lifecycle

Set the base URL once:

```bash
BASE_URL=http://127.0.0.1:3000
TASK_ID=tsk_DEMOISSUETOSHIP01
```

### 1. List Assigned Work

```bash
curl -s "$BASE_URL/tasks/mine?status=in_progress&limit=1"
```

The demo task response includes compact next actions:

```json
{
  "data": [
    {
      "id": "tsk_DEMOISSUETOSHIP01",
      "identifier": "AGEA-10-DEMO",
      "status": "in_progress",
      "availableActions": ["submit"]
    }
  ],
  "availableActions": []
}
```

### 2. Submit the First Attempt

```bash
curl -s -X POST "$BASE_URL/tasks/$TASK_ID/submit" \
  -H "content-type: application/json" \
  -H "idempotency-key: quickstart-submit-1" \
  -d '{
    "summary": "Implemented the endpoint and opened a pull request.",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" }
    ],
    "checks": [{ "name": "unit-tests", "status": "failed" }]
  }'
```

The first demo submission intentionally returns work to the agent: CI fails and review requests a fix.

### 3. Read CI and Review Feedback

```bash
curl -s "$BASE_URL/tasks/$TASK_ID/ci-status"
curl -s "$BASE_URL/tasks/$TASK_ID/review-feedback"
```

The responses include targeted failure context and `availableActions`, so an agent can avoid reading raw CI logs or polling provider APIs.

### 4. Resubmit the Fixed Attempt

```bash
curl -s -X POST "$BASE_URL/tasks/$TASK_ID/submit" \
  -H "content-type: application/json" \
  -H "idempotency-key: quickstart-submit-2" \
  -d '{
    "summary": "Fixed idempotency handling and added regression coverage.",
    "artifacts": [
      { "type": "pull_request", "url": "https://github.com/oxnw/agentrail/pull/42" },
      { "type": "commit", "url": "https://github.com/oxnw/agentrail/commit/b5bc7f86" }
    ],
    "checks": [{ "name": "unit-tests", "status": "passed" }]
  }'
```

### 5. Ship the Approved Task

```bash
curl -s -X POST "$BASE_URL/tasks/$TASK_ID/ship" \
  -H "content-type: application/json" \
  -H "idempotency-key: quickstart-ship-1" \
  -d '{
    "mode": "merge_and_deploy",
    "targetEnvironment": "production",
    "expectedHeadSha": "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0"
  }'
```

Expected ship response:

```json
{
  "data": {
    "taskId": "tsk_DEMOISSUETOSHIP01",
    "operationId": "shp_DEMOSHIPOPERATION1",
    "status": "queued",
    "availableActions": ["rollback"]
  },
  "availableActions": ["rollback"]
}
```

## SDK Demo

The scripted demo runs the same lifecycle and prints estimated token savings:

```bash
npm run demo
```

Machine-readable output:

```bash
npm run demo:json
```

## Stop and Reset

Stop the local API:

```bash
docker compose down
```

Reset persisted task event replay data:

```bash
docker compose down -v
```

## Technical Decision

Chosen: Docker Compose is the one-command local setup for this release because it keeps the OSS demo deterministic, requires no hosted account, and persists event replay data for self-hosters.

Rejected for this release: an `npx` server launcher. The public package surface is the SDK, not a stable CLI binary, so documenting an `npx` path would imply a support contract the repo does not yet provide.

# @agentrail-core/sdk

TypeScript SDK for the AgentRail Task Lifecycle API.

## Install

```bash
npm install @agentrail-core/sdk
```

Requires Node.js >= 18.0.0 (uses native `fetch`).

## Quickstart

Start the local OSS demo API from the repository root:

```bash
npm start
```

```typescript
import { AgentRailClient } from "@agentrail-core/sdk";

const client = new AgentRailClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
});

// List assigned tasks
const tasks = await client.listMyTasks({ status: "todo" });
for (const task of tasks.data) {
  console.log(`${task.identifier}: ${task.title}`);
}

// Get task details
const detail = await client.getTask("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");

// Submit work for review
const submission = await client.submitTask(
  "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
  {
    summary: "Implemented the feature",
    artifacts: [
      { type: "pull_request", url: "https://github.com/org/repo/pull/42" },
    ],
  },
  "submit-AGEA-2-v1", // idempotency key
);

// Check CI status
const ci = await client.getTaskCiStatus("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");
console.log(`CI: ${ci.data.overallStatus}`);

// Get review feedback
const feedback = await client.getTaskReviewFeedback("tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V");
console.log(`Decision: ${feedback.data.latestDecision.outcome}`);

// Ship approved task
const ship = await client.shipTask(
  "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
  {
    mode: "merge_and_deploy",
    targetEnvironment: "production",
    expectedHeadSha: "b5bc7f86b9ad94f4f18f83d28bdf3e27a31e53a0",
  },
  "ship-AGEA-2-v1",
);
```

For the default OSS `npm start` server, `ar_local_demo_key` is only a local
placeholder because agent auth is not enabled. In an auth-enabled deployment,
use the returned `data.apiKey` value from key creation; it starts with
`ar_live_`. The `akey_...` value is the key ID, not the secret.

## Authentication

Create an API key, then use it to initialize the client:

```typescript
// Bootstrap: create the first admin key (no auth required)
const client = new AgentRailClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: "", // empty for bootstrap
});

const key = await client.createApiKey(
  {
    agent: {
      id: "agt_my_agent",
      displayName: "My Agent",
      role: "developer",
      externalIdentities: [{ provider: "github", subject: "my-bot" }],
    },
    scopes: ["auth:admin"],
    rateLimit: { windowSeconds: 60, maxRequests: 600 },
  },
  "bootstrap-key-v1",
);

console.log(`API Key: ${key.data.apiKey}`);
```

## Retry Logic

The client retries failed requests with exponential backoff. Customize behavior:

```typescript
const client = new AgentRailClient({
  baseUrl: process.env.AGENTRAIL_BASE_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.AGENTRAIL_API_KEY ?? "ar_local_demo_key",
  retry: {
    maxAttempts: 5,          // default: 3
    initialDelayMs: 500,      // default: 1000
    maxDelayMs: 60_000,       // default: 30000
    retryableStatusCodes: [429, 500, 502, 503, 504], // default
  },
});
```

For AgentRail Cloud, pass `baseUrl: "https://api.agentrail.dev/v1"` explicitly.

Rate-limited responses (429) respect the `Retry-After` header automatically.

## Error Handling

All API errors throw typed `AgentRailError` subclasses:

```typescript
import {
  AgentRailClient,
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@agentrail-core/sdk";

try {
  await client.shipTask(taskId, request, idempotencyKey);
} catch (err) {
  if (err instanceof ConflictError) {
    console.log("Task not shippable:", err.details);
  } else if (err instanceof NotFoundError) {
    console.log("Task not found");
  } else if (err instanceof RateLimitError) {
    console.log(`Retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof ValidationError) {
    console.log("Bad request:", err.details);
  }
}
```

## Webhooks

Register a webhook subscription and verify incoming events:

```typescript
import { AgentRailClient, parseWebhookEvent } from "@agentrail-core/sdk";

// Register
const sub = await client.createWebhookSubscription(
  {
    url: "https://my-app.example.com/webhooks/tasks",
    eventTypes: ["task.updated", "task.reviewed", "task.shipped"],
    secret: "whsec_my_secret_at_least_16",
  },
  "webhook-sub-v1",
);

const subscriptions = await client.listWebhookSubscriptions();
const current = await client.getWebhookSubscription(sub.data.id);

// Verify and parse incoming webhook (e.g. in an Express handler)
const event = parseWebhookEvent(rawBody, "whsec_my_secret_at_least_16", {
  "x-agentrail-webhook-id": req.headers["x-agentrail-webhook-id"],
  "x-agentrail-event-id": req.headers["x-agentrail-event-id"],
  "x-agentrail-event-type": req.headers["x-agentrail-event-type"],
  "x-agentrail-delivery-id": req.headers["x-agentrail-delivery-id"],
  "x-agentrail-delivery-attempt": req.headers["x-agentrail-delivery-attempt"],
  "x-agentrail-signature": req.headers["x-agentrail-signature"],
});

switch (event.type) {
  case "task.updated":
    console.log(`Task ${event.data.taskIdentifier} → ${event.data.status}`);
    break;
  case "task.reviewed":
    console.log(`Review: ${event.data.reviewOutcome}`);
    break;
  case "task.shipped":
    console.log(`Shipped to ${event.data.targetEnvironment}`);
    break;
}
```

## Event Stream (SSE)

Stream real-time task lifecycle events:

```typescript
const controller = new AbortController();

for await (const event of client.streamEvents({
  eventTypes: ["task.updated"],
  signal: controller.signal,
})) {
  console.log(event.type, event.data);
}
```

## API Key Management

```typescript
// Rotate a key
const rotated = await client.rotateApiKey(
  "akey_01JY52RRF5PAGHT5DCZXJ4N2DG",
  { expiresAt: "2026-07-01T00:00:00Z" },
  "rotate-key-v1",
);

// Check usage
const usage = await client.getApiKeyUsage("akey_01JY52RRF5PAGHT5DCZXJ4N2DG");
console.log(`Requests: ${usage.data.totals.accepted}`);
```

# @agentrail/sdk

TypeScript SDK for the AgentRail Task Lifecycle API.

## Install

```bash
npm install @agentrail/sdk
```

## Quickstart

```typescript
import { AgentRailClient } from "@agentrail/sdk";

const client = new AgentRailClient({
  baseUrl: "https://your-agentrail-instance.com",
  token: process.env.AGENTRAIL_TOKEN!,
});

// List your assigned tasks
const { tasks } = await client.listTasks("my-github-username");

// Get full task details
const { task } = await client.getTask(tasks[0].id);

// Submit a PR for a task
const result = await client.submitTask(task.id, {
  head: "feature/my-branch",
  reviewers: ["teammate"],
});

// Get unified review feedback
const feedback = await client.getReviewFeedback(task.id, result.pr.number);
console.log(`${feedback.summary.required} required changes`);

// Ship it (merge + close)
await client.shipTask(task.id, result.pr.number, "squash");
```

## Pagination

```typescript
for await (const page of client.paginateTasks("my-username")) {
  for (const task of page.tasks) {
    console.log(task.title);
  }
}
```

## Webhooks

```typescript
import { verifyWebhookSignature, WebhookRouter } from "@agentrail/sdk";

// Register a webhook
await client.registerWebhook("https://my-server.com/hooks", [
  "task.created",
  "task.status_changed",
]);

// Verify and route incoming webhooks
const router = new WebhookRouter();
router.on("task.created", async (payload) => {
  console.log("New task:", payload.taskId);
});

// In your Express handler:
app.post("/hooks", (req, res) => {
  const sig = req.headers["x-agentrail-signature"] as string;
  if (!verifyWebhookSignature(req.body, sig, process.env.WEBHOOK_SECRET!)) {
    return res.status(401).send("Invalid signature");
  }
  router.handle(JSON.parse(req.body));
  res.sendStatus(200);
});
```

## Error Handling

```typescript
import { AgentRailError, NetworkError, TimeoutError } from "@agentrail/sdk";

try {
  await client.getTask("nonexistent");
} catch (err) {
  if (err instanceof AgentRailError) {
    console.log(err.status, err.code, err.availableActions);
  }
  if (err instanceof TimeoutError) {
    console.log("Request timed out");
  }
  if (err instanceof NetworkError) {
    console.log("Network failure:", err.cause);
  }
}
```

## Configuration

```typescript
const client = new AgentRailClient({
  baseUrl: "https://your-instance.com",
  token: "your-token",
  retries: 3,           // default: 2
  retryDelayMs: 1000,   // default: 500 (exponential backoff)
  timeoutMs: 60000,     // default: 30000
});
```

Retries use exponential backoff and only trigger on 429 (rate limit) and 5xx (server) errors.

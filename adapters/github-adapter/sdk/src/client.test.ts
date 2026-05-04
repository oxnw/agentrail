import { AgentRailClient } from "./client";
import { AgentRailError, NetworkError, TimeoutError, isRetryable } from "./errors";
import { verifyWebhookSignature, parseWebhookPayload, WebhookRouter } from "./webhooks";
import { createHmac } from "crypto";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// --- Client construction ---
console.log("\nClient construction");
{
  const client = new AgentRailClient({
    baseUrl: "https://api.example.com/",
    token: "test-token",
  });
  assert(client instanceof AgentRailClient, "creates client instance");
}

{
  const client = new AgentRailClient({
    baseUrl: "https://api.example.com",
    token: "tok",
    retries: 5,
    retryDelayMs: 1000,
    timeoutMs: 60000,
  });
  assert(client instanceof AgentRailClient, "accepts custom retry/timeout config");
}

// --- Error classes ---
console.log("\nError classes");
{
  const err = new AgentRailError(404, {
    error: "Not found",
    code: "not_found",
    availableActions: ["GET /tasks/mine"],
  });
  assert(err instanceof Error, "AgentRailError extends Error");
  assertEqual(err.status, 404, "AgentRailError preserves status");
  assertEqual(err.code, "not_found", "AgentRailError preserves code");
  assertEqual(err.message, "Not found", "AgentRailError preserves message");
  assertEqual(err.availableActions, ["GET /tasks/mine"], "AgentRailError preserves availableActions");
  assertEqual(err.name, "AgentRailError", "AgentRailError has correct name");
}

{
  const cause = new Error("ECONNREFUSED");
  const err = new NetworkError("Request failed", cause);
  assert(err instanceof Error, "NetworkError extends Error");
  assertEqual(err.name, "NetworkError", "NetworkError has correct name");
  assertEqual(err.cause, cause, "NetworkError preserves cause");
}

{
  const err = new TimeoutError("https://api.example.com/tasks", 5000);
  assert(err instanceof Error, "TimeoutError extends Error");
  assertEqual(err.name, "TimeoutError", "TimeoutError has correct name");
  assert(err.message.includes("5000ms"), "TimeoutError includes timeout in message");
}

// --- isRetryable ---
console.log("\nisRetryable");
assertEqual(isRetryable(429), true, "429 is retryable");
assertEqual(isRetryable(500), true, "500 is retryable");
assertEqual(isRetryable(502), true, "502 is retryable");
assertEqual(isRetryable(503), true, "503 is retryable");
assertEqual(isRetryable(400), false, "400 is not retryable");
assertEqual(isRetryable(401), false, "401 is not retryable");
assertEqual(isRetryable(404), false, "404 is not retryable");
assertEqual(isRetryable(409), false, "409 is not retryable");

// --- Webhook signature verification ---
console.log("\nWebhook signature verification");
{
  const secret = "webhook-secret-123";
  const payload = '{"event":"task.created","taskId":"1"}';
  const expectedSig = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  assert(verifyWebhookSignature(payload, expectedSig, secret), "valid signature passes");
  assert(!verifyWebhookSignature(payload, "sha256=wrong", secret), "invalid signature fails");
  assert(!verifyWebhookSignature(payload, expectedSig, "wrong-secret"), "wrong secret fails");
  assert(!verifyWebhookSignature("modified", expectedSig, secret), "modified payload fails");
}

// --- Webhook payload parsing ---
console.log("\nWebhook payload parsing");
{
  const raw = '{"event":"task.updated","taskId":"abc","timestamp":"2026-01-01T00:00:00Z","data":{}}';
  const parsed = parseWebhookPayload(raw);
  assertEqual(parsed.event, "task.updated", "parses event");
  assertEqual(parsed.taskId, "abc", "parses taskId");
}

// --- WebhookRouter ---
console.log("\nWebhookRouter");
{
  const router = new WebhookRouter();
  const calls: string[] = [];

  router.on("task.created", async (p) => { calls.push(`created:${p.taskId}`); });
  router.on("*", async (p) => { calls.push(`wildcard:${p.taskId}`); });
  router.on("task.updated", async (p) => { calls.push(`updated:${p.taskId}`); });

  (async () => {
    await router.handle({ event: "task.created", taskId: "1", timestamp: "", data: {} });
    assertEqual(calls, ["created:1", "wildcard:1"], "routes to specific + wildcard handlers");

    calls.length = 0;
    await router.handle({ event: "task.updated", taskId: "2", timestamp: "", data: {} });
    assertEqual(calls, ["updated:2", "wildcard:2"], "routes updated event correctly");

    calls.length = 0;
    await router.handle({ event: "task.shipped", taskId: "3", timestamp: "", data: {} });
    assertEqual(calls, ["wildcard:3"], "unhandled event goes to wildcard only");
  })().then(() => {
    // --- Type exports ---
    console.log("\nType exports");
    try {
      require("./index");
      assert(true, "index barrel exports without error");
    } catch (e) {
      console.error(e);
      assert(false, "index barrel exports");
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
}

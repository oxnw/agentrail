import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { createServer } from "../src/app.ts";
import { runCli } from "../src/cli/index.ts";
import { AgentRailEventSubscriptionStore } from "../src/event-subscription-store.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

class BufferWriter {
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://${address.address}:${address.port}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("agentrail event CLI manages event subscriptions", async (t) => {
  const now = () => new Date("2026-05-11T12:00:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventSubscriptionStore = new AgentRailEventSubscriptionStore({ now });
  const apiKey = authStore.createKey({
    agent: { id: "agt_operator", displayName: "Operator", role: "operator" },
    scopes: ["webhooks:read", "webhooks:write"],
  }, "event-cli-key-v1").data.apiKey;
  const server = createServer({
    store: new TaskEventStore({ now }),
    authStore,
    eventSubscriptionStore,
    now,
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const subscribeStdout = new BufferWriter();
  const subscribeStderr = new BufferWriter();
  const subscribeExitCode = await runCli([
    "event",
    "subscribe",
    "--url",
    "https://example.com/agentrail/events",
    "--event-types",
    "task.awaiting_user,task.updated",
    "--task-id",
    "tsk_focus",
    "--base-url",
    baseUrl,
    "--setup-api-key",
    apiKey,
    "--json",
  ], {
    cwd: process.cwd(),
    stdout: subscribeStdout,
    stderr: subscribeStderr,
  });

  assert.equal(subscribeExitCode, 0, subscribeStderr.toString());
  const created = JSON.parse(subscribeStdout.toString());
  assert.match(created.data.id, /^evsub_/);
  assert.match(created.generatedSecret, /^evsec_/);
  assert.deepEqual(created.data.eventTypes, ["task.awaiting_user", "task.updated"]);
  assert.deepEqual(created.data.filters.taskIds, ["tsk_focus"]);

  const listStdout = new BufferWriter();
  const listStderr = new BufferWriter();
  const listExitCode = await runCli([
    "event",
    "subscriptions",
    "--base-url",
    baseUrl,
    "--setup-api-key",
    apiKey,
  ], {
    cwd: process.cwd(),
    stdout: listStdout,
    stderr: listStderr,
  });

  assert.equal(listExitCode, 0, listStderr.toString());
  const expectedListRow = `${created.data.id}\tactive\ttask.awaiting_user,task.updated\thttps://example.com/agentrail/events`;
  assert.match(listStdout.toString(), new RegExp(escapeRegExp(expectedListRow)));

  const unsubscribeStdout = new BufferWriter();
  const unsubscribeStderr = new BufferWriter();
  const unsubscribeExitCode = await runCli([
    "event",
    "unsubscribe",
    "--subscription-id",
    created.data.id,
    "--base-url",
    baseUrl,
    "--setup-api-key",
    apiKey,
  ], {
    cwd: process.cwd(),
    stdout: unsubscribeStdout,
    stderr: unsubscribeStderr,
  });

  assert.equal(unsubscribeExitCode, 0, unsubscribeStderr.toString());
  assert.equal(eventSubscriptionStore.getSubscription(created.data.id)?.data.status, "disabled");
});

test("agentrail event CLI preserves base URL path prefixes", async (t) => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const previousBaseUrl = process.env.AGENTRAIL_BASE_URL;
  const previousSetupKey = process.env.AGENTRAIL_SETUP_API_KEY;
  let requestedUrl = "";

  process.env.AGENTRAIL_BASE_URL = "https://api.example.com/v1";
  process.env.AGENTRAIL_SETUP_API_KEY = "setup_test_key";

  t.after(() => {
    if (previousBaseUrl === undefined) delete process.env.AGENTRAIL_BASE_URL;
    else process.env.AGENTRAIL_BASE_URL = previousBaseUrl;
    if (previousSetupKey === undefined) delete process.env.AGENTRAIL_SETUP_API_KEY;
    else process.env.AGENTRAIL_SETUP_API_KEY = previousSetupKey;
  });

  const exitCode = await runCli([
    "event",
    "subscriptions",
    "--json",
  ], {
    cwd: process.cwd(),
    stdout,
    stderr,
    eventFetch: (async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [], availableActions: ["create"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(requestedUrl, "https://api.example.com/v1/event-subscriptions");
  assert.deepEqual(JSON.parse(stdout.toString()), { data: [], availableActions: ["create"] });
});

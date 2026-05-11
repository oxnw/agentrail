import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { createServer } from "../src/app.ts";
import { runCli } from "../src/cli/index.ts";
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

async function createBlockedTaskFixture(t: test.TestContext, { blocked = true } = {}) {
  const now = () => new Date("2026-05-11T01:00:00Z");
  const authStore = new AgentAuthStore({ now });
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const task = taskQueue.createTask({
    identifier: "AGEA-CLI-BLOCKER",
    title: "Resolve blocker from CLI",
    assignee: { id: "agt_cli", name: "CLI Agent" },
    assigneeAgentId: "agt_cli",
    status: blocked ? "in_progress" : "todo",
    availableActions: blocked ? ["submit"] : ["start"],
  });
  const apiKey = authStore.createKey(
    {
      agent: { id: "agt_cli", displayName: "CLI Agent", role: "agent" },
      scopes: ["tasks:read", "tasks:write"],
    },
    `key-${blocked ? "blocked" : "todo"}`,
  ).data.apiKey;

  if (blocked) {
    await taskQueue.blockTaskAwaitingUser(
      task.id,
      {
        sourceRunId: "run_cli_blocked",
        sourceAgentId: "agt_cli",
        reason: "Need user confirmation.",
        actionRequired: "Confirm the deployment target.",
        resumeInstructions: "Resume after confirmation.",
      },
      "block-test",
      "agt_cli",
    );
  }

  const server = createServer({
    store: eventStore,
    taskLifecycleStore: taskQueue,
    authStore,
    now,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = await listen(server);

  return { apiKey, baseUrl, task, taskQueue };
}

test("agentrail task resolve-blocker resolves a blocked task through the CLI", async (t) => {
  const { apiKey, baseUrl, task, taskQueue } = await createBlockedTaskFixture(t);
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(
    [
      "task",
      "resolve-blocker",
      "--task-id",
      task.id,
      "--resolution-summary",
      "User chose staging.",
      "--base-url",
      baseUrl,
      "--setup-api-key",
      apiKey,
    ],
    { cwd: process.cwd(), stdout, stderr },
  );

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), new RegExp(`Resolved blocker for ${task.id}\\.\\nStatus: todo\\n`));
  assert.equal(stderr.toString(), "");
  const stored = taskQueue.getRawTask(task.id);
  assert.equal(stored?.status, "todo");
  assert.deepEqual(stored?.availableActions, ["start"]);
  assert.equal(stored?.blocker, null);
});

test("agentrail task resolve-blocker --json prints a parseable API envelope", async (t) => {
  const { apiKey, baseUrl, task } = await createBlockedTaskFixture(t);
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(
    [
      "task",
      "resolve-blocker",
      "--task-id",
      task.id,
      "--resolution-summary",
      "User chose production.",
      "--base-url",
      baseUrl,
      "--setup-api-key",
      apiKey,
      "--json",
    ],
    { cwd: process.cwd(), stdout, stderr },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  const body = JSON.parse(stdout.toString());
  assert.equal(body.data.id, task.id);
  assert.equal(body.data.status, "todo");
  assert.deepEqual(body.data.availableActions, ["start"]);
  assert.equal(body.data.blocker, null);
});

test("agentrail task resolve-blocker preserves base URL path prefixes", async (t) => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const previousBaseUrl = process.env.AGENTRAIL_BASE_URL;
  const previousSetupKey = process.env.AGENTRAIL_SETUP_API_KEY;
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";

  process.env.AGENTRAIL_BASE_URL = "https://api.example.com/v1";
  process.env.AGENTRAIL_SETUP_API_KEY = "setup_test_key";
  globalThis.fetch = (async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      data: { status: "todo" },
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  t.after(() => {
    if (previousBaseUrl === undefined) delete process.env.AGENTRAIL_BASE_URL;
    else process.env.AGENTRAIL_BASE_URL = previousBaseUrl;
    if (previousSetupKey === undefined) delete process.env.AGENTRAIL_SETUP_API_KEY;
    else process.env.AGENTRAIL_SETUP_API_KEY = previousSetupKey;
    globalThis.fetch = previousFetch;
  });

  const exitCode = await runCli(
    [
      "task",
      "resolve-blocker",
      "--task-id",
      "tsk_prefixed",
      "--resolution-summary",
      "User fixed the blocker.",
    ],
    { cwd: process.cwd(), stdout, stderr },
  );

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(requestedUrl, "https://api.example.com/v1/tasks/tsk_prefixed/resolve-blocker");
});

test("agentrail task resolve-blocker returns code 1 with clear stderr when required flags are missing", async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(["task", "resolve-blocker", "--task-id", "tsk_missing_summary"], {
    cwd: process.cwd(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /requires --task-id and --resolution-summary/);
});

test("agentrail task resolve-blocker returns code 1 for server validation conflicts", async (t) => {
  const { apiKey, baseUrl, task } = await createBlockedTaskFixture(t, { blocked: false });
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(
    [
      "task",
      "resolve-blocker",
      "--task-id",
      task.id,
      "--resolution-summary",
      "Nothing to resolve.",
      "--base-url",
      baseUrl,
      "--setup-api-key",
      apiKey,
    ],
    { cwd: process.cwd(), stdout, stderr },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /awaiting-user blocker to resolve/i);
});

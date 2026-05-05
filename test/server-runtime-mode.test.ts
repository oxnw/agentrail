import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { TaskStore } from "../src/task-store.ts";
const DEMO_TASK_ID = "tsk_DEMOISSUETOSHIP01";

test("server mode does not expose a seeded lifecycle fixture by default", async (t) => {
  const port = 34000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      AGENTRAIL_HOST: "127.0.0.1",
      AGENTRAIL_PORT: String(port),
      AGENTRAIL_TASK_SOURCES: JSON.stringify({
        tsk_LIVEONLY01: {
          provider: "github",
          owner: "oxnw",
          repo: "agentrail",
          issueNumber: 96,
          defaultBranch: "main"
        }
      }),
      GITHUB_TOKEN: "ghp_testtoken",
      CIRCLECI_TOKEN: "",
      CIRCLECI_WEBHOOK_SECRET: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(() => {
    if (!server.killed) {
      server.kill("SIGTERM");
    }
  });

  const output = [];
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => output.push(chunk));
  server.stderr.on("data", (chunk) => output.push(chunk));

  await waitForServerReady(server, output);

  // Bootstrap an admin API key so we can test task isolation behind auth
  const bootstrapRes = await fetch(`http://127.0.0.1:${port}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `bootstrap-${port}`,
    },
    body: JSON.stringify({
      agent: { id: "agt_test_runtime", displayName: "Runtime Test", role: "test" },
      scopes: ["auth:admin", "tasks:read"],
    }),
  });
  const bootstrapText = await bootstrapRes.text();
  assert.equal(bootstrapRes.status, 201, `Bootstrap failed: ${bootstrapText}`);
  const bootstrapBody = JSON.parse(bootstrapText);
  const apiKey = bootstrapBody.data.apiKey;

  const mineRes = await fetch(`http://127.0.0.1:${port}/tasks/mine`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const mineBody = await mineRes.json();
  assert.equal(mineRes.status, 200);
  assert.equal(mineBody.data.length, 0, "server mode should not expose fixture tasks in the per-agent queue");

  const response = await fetch(`http://127.0.0.1:${port}/tasks/${DEMO_TASK_ID}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.doesNotMatch(body, new RegExp(DEMO_TASK_ID));
});

async function waitForServerReady(server, output) {
  let timeout;
  const onDataCallbacks = [];

  try {
    await Promise.race([
      new Promise((resolve) => {
        const onData = () => {
          if (output.join("").includes("API listening")) {
            server.stdout.off("data", onData);
            resolve(undefined);
          }
        };
        onDataCallbacks.push(onData);
        server.stdout.on("data", onData);
        onData();
      }),
      once(server, "exit").then(([code]) => {
        throw new Error(`server exited before listening with code ${code}: ${output.join("")}`);
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`server did not start listening: ${output.join("")}`)), 10_000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    for (const onData of onDataCallbacks) {
      server.stdout.off("data", onData);
    }
  }
}

test("server mode serves configured durable task store records", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-server-store-"));
  const storagePath = path.join(tempDir, "tasks.json");
  const persistedStore = new TaskStore({
    now: () => new Date("2026-05-05T13:00:00Z"),
    storagePath,
  });
  const storedTask = persistedStore.createTask({
    identifier: "AGEA-97",
    title: "Durable live task store",
    description: "Return stored AgentRail tasks in server mode.",
    status: "in_progress",
    priority: "critical",
    assignee: { id: "agt_store_runtime", name: "Runtime Agent" },
    acceptanceCriteria: ["GET /tasks/mine returns stored tasks"],
    links: {
      issue: "https://github.com/oxnw/agentrail/issues/97",
    },
    context: {
      project: "oxnw/agentrail",
      goal: "server-mode task queue",
    },
    availableActions: ["submit", "view_ci_status"],
    source: {
      provider: "github",
      owner: "oxnw",
      repo: "agentrail",
      issueNumber: 97,
    },
  });

  const port = 35000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      AGENTRAIL_HOST: "127.0.0.1",
      AGENTRAIL_PORT: String(port),
      AGENTRAIL_TASK_STORE_PATH: storagePath,
      AGENTRAIL_TASK_SOURCES: JSON.stringify({
        [storedTask.id]: {
          provider: "github",
          owner: "oxnw",
          repo: "agentrail",
          issueNumber: 97,
          defaultBranch: "main",
        },
      }),
      GITHUB_TOKEN: "ghp_testtoken",
      AGENTRAIL_MODE: "server",
      CIRCLECI_TOKEN: "",
      CIRCLECI_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    if (!server.killed) {
      server.kill("SIGTERM");
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const output = [];
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => output.push(chunk));
  server.stderr.on("data", (chunk) => output.push(chunk));

  await waitForServerReady(server, output);

  const bootstrapRes = await fetch(`http://127.0.0.1:${port}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `bootstrap-store-${port}`,
    },
    body: JSON.stringify({
      agent: { id: "agt_store_runtime", displayName: "Runtime Agent", role: "test" },
      scopes: ["auth:admin", "tasks:read"],
    }),
  });
  const bootstrapText = await bootstrapRes.text();
  assert.equal(bootstrapRes.status, 201, `Bootstrap failed: ${bootstrapText}`);
  const apiKey = JSON.parse(bootstrapText).data.apiKey;

  const mineRes = await fetch(`http://127.0.0.1:${port}/tasks/mine?status=in_progress`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const mineBody = await mineRes.json();
  assert.equal(mineRes.status, 200);
  assert.deepEqual(mineBody.data.map((task) => task.id), [storedTask.id]);
  assert.equal(mineBody.data[0].title, "Durable live task store");
  assert.deepEqual(mineBody.data[0].availableActions, ["submit"]);

  const detailRes = await fetch(`http://127.0.0.1:${port}/tasks/${storedTask.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const detailBody = await detailRes.json();
  assert.equal(detailRes.status, 200);
  assert.equal(detailBody.data.id, storedTask.id);
  assert.equal(detailBody.data.links.issue, "https://github.com/oxnw/agentrail/issues/97");
  assert.deepEqual(detailBody.availableActions, ["submit", "view_ci_status"]);
});

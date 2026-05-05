import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

const DEMO_TASK_ID = "tsk_DEMOISSUETOSHIP01";

test("default non-demo server mode does not expose deterministic demo task", async (t) => {
  const port = 34000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["src/server.js"], {
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
      AGENTRAIL_MODE: "",
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

  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(([code]) => {
      throw new Error(`server exited before listening with code ${code}: ${output.join("")}`);
    })
  ]);

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
  assert.equal(mineBody.data.length, 0, "server mode should not expose demo tasks in per-agent queue");

  const response = await fetch(`http://127.0.0.1:${port}/tasks/${DEMO_TASK_ID}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.doesNotMatch(body, new RegExp(DEMO_TASK_ID));
});
